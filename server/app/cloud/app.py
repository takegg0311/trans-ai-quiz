"""Cloud Run 専用アプリ。from_environment を uvicorn --factory で起動する。"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import mimetypes
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from ..jev.router import router as jev_router
from ..llm.router import health as llm_health, predict as llm_predict
from ..protocol import BuzzAcceptedMessage, BuzzRejectedMessage, ClientMessage, ErrorMessage, WelcomeMessage
from ..quiz import REPO_ROOT, QuizDataError
from ..ws import ConnectionManager
from .archive import MAX_ZIP_BYTES, unpack
from .auth import COOKIE, check_origin, issue, session
from .service import Settings, TournamentService, execute
from .snapshot import load_room
from .store import CloudStorageStore, FirestoreStore, IObjectStore, IStateStore

logger = logging.getLogger(__name__)


class Login(BaseModel):
    password: str = Field(max_length=1024)


def create_app(settings: Settings, states: IStateStore, objects: IObjectStore) -> FastAPI:
    service = TournamentService(settings, states, objects)
    manager = ConnectionManager()
    # 同一プロセス内は受信順にトランザクションへ進める。
    lock = asyncio.Lock()
    sockets: dict[WebSocket, str] = {}
    last_version: dict[WebSocket, int] = {}
    deadlines: dict[WebSocket, float] = {}
    changed = asyncio.Event()
    asset_cache: dict[str, tempfile.TemporaryDirectory] = {}
    adapter = TypeAdapter(ClientMessage)

    async def publish(value: dict) -> None:
        room = load_room(value["room"], await asyncio.to_thread(service.questions, value))
        for socket in list(sockets):
            if sockets[socket] != value["id"]:
                continue
            if last_version.get(socket, -1) >= value["version"]:
                continue
            last_version[socket] = value["version"]
            message = room.to_state_message(for_host=socket in manager.hosts).model_dump()
            message.update(paused=value["paused"], version=value["version"])
            if socket in manager.hosts:
                message.update(ai_enabled=value.get("ai_enabled", False), ai_read_text=value.get("ai_context", ""))
            try:
                await socket.send_json(message)
            except (RuntimeError, WebSocketDisconnect):
                pass

    async def close_ended(value: dict | None) -> None:
        for socket, event_id in list(sockets.items()):
            if (value and service.active(value) and event_id == value["id"]
                    and deadlines.get(socket, 0) > service.clock()):
                continue
            try:
                await socket.send_json({"type": "error", "code": "ended", "message": "大会は終了しました。"})
                await socket.close(code=4404)
            except (RuntimeError, WebSocketDisconnect):
                pass
            sockets.pop(socket, None)
            deadlines.pop(socket, None)
            last_version.pop(socket, None)
            manager.hosts.discard(socket)
            for player_id, player_socket in list(manager.players.items()):
                if player_socket is socket:
                    manager.players.pop(player_id, None)
        for event_id in list(asset_cache):
            if value and service.active(value) and value["id"] == event_id:
                continue
            asset_cache.pop(event_id).cleanup()

    async def monitor() -> None:
        next_heartbeat = 0.0
        latest = None
        while True:
            try:
                async with lock:
                    heartbeat_due = asyncio.get_running_loop().time() >= next_heartbeat
                    latest = await asyncio.to_thread(service.heartbeat if heartbeat_due else service.read)
                    if heartbeat_due:
                        next_heartbeat = asyncio.get_running_loop().time() + 2
                    await close_ended(latest)
                    if service.active(latest):
                        await publish(latest)
            except Exception:
                logger.exception("大会状態の同期に失敗しました。")
                # 保存先に接続できない場合も、既知の終了日時を越えて接続を維持しない。
                await close_ended(latest)
            try:
                await asyncio.wait_for(changed.wait(), timeout=2)
                changed.clear()
            except TimeoutError:
                pass

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal lock, changed
        lock = asyncio.Lock()
        changed = asyncio.Event()
        loop = asyncio.get_running_loop()
        watch = states.watch("current", lambda: loop.call_soon_threadsafe(changed.set)) if hasattr(states, "watch") else None
        task = asyncio.create_task(monitor())
        yield
        if watch is not None:
            await asyncio.to_thread(watch.unsubscribe)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        for directory in asset_cache.values():
            directory.cleanup()
        asset_cache.clear()

    app = FastAPI(title="trans-ai-quiz cloud", lifespan=lifespan)
    app.state.service = service

    @app.middleware("http")
    async def protect(request: Request, call_next):
        try:
            if request.url.path.startswith(("/api/", "/quiz_data/")):
                if request.method not in ("GET", "HEAD"):
                    check_origin(request, settings)
                    if request.headers.get("x-quiz-request") != "1":
                        raise HTTPException(403, "操作ヘッダーが必要です。")
                response = await call_next(request)
                response.headers["Cache-Control"] = "no-store"
                return response
            return await call_next(request)
        except HTTPException as error:
            return JSONResponse({"detail": error.detail}, status_code=error.status_code)

    async def host(request: Request) -> dict:
        credential = session(request, settings, service.clock())
        value = await asyncio.to_thread(service.read)
        return service.require(value, credential["event"])

    async def setup(request: Request) -> None:
        credential = session(request, settings, service.clock())
        if credential["event"] != "setup":
            raise HTTPException(403, "新しい大会を開始するには再認証してください。")

    def set_cookie(response: Response, value: dict | None) -> None:
        event_id = value["id"] if service.active(value) else "setup"
        until = value["expires_at"] if service.active(value) else service.clock() + 600
        response.set_cookie(COOKIE, issue(settings, event_id, until), httponly=True,
                            secure=settings.secure_cookie, samesite="strict",
                            max_age=max(1, int(until - service.clock())), path="/")

    @app.exception_handler(QuizDataError)
    async def invalid_quiz(request: Request, error: QuizDataError):
        return JSONResponse({"detail": str(error)}, status_code=422)

    @app.get("/api/health")
    async def healthz():
        return {"ok": True}

    @app.get("/api/cloud")
    async def cloud_info():
        return {"cloud": True, "max_zip_bytes": MAX_ZIP_BYTES}

    @app.post("/api/session")
    async def login(body: Login, request: Request, response: Response):
        # Cloud Run の ingress 経路で付与された接続元を利用。任意の XFF は信用しない。
        address = request.client.host if request.client else "unknown"
        await asyncio.to_thread(service.check_password, body.password, address)
        value = await asyncio.to_thread(service.read)
        set_cookie(response, value)
        return {"active": service.active(value)}

    @app.get("/api/session")
    async def session_info(request: Request):
        value = await host(request)
        return {"active": True, "id": value["id"], "expires_at": value["expires_at"]}

    @app.post("/api/tournament", dependencies=[Depends(setup)])
    async def start(request: Request, response: Response, hours: float = 24):
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > MAX_ZIP_BYTES:
                raise HTTPException(413, "ZIP は24 MiB以下にしてください。")
            data.extend(chunk)
        async with lock:
            value = await asyncio.to_thread(service.start, bytes(data), hours)
            await close_ended(value)
        set_cookie(response, value)
        return {"id": value["id"], "expires_at": value["expires_at"]}

    @app.post("/api/tournament/end")
    async def end(request: Request, response: Response):
        value = await host(request)
        async with lock:
            ended = await asyncio.to_thread(service.end, value["id"])
            await close_ended(ended)
        response.delete_cookie(COOKIE, path="/")
        return {"ended": True}

    @app.get("/api/room")
    async def room_info(request: Request):
        value = await host(request)
        questions = await asyncio.to_thread(service.questions, value)
        return {"join_url": f"{settings.public_url.rstrip('/')}/player?event={value['id']}&key={value['join_key']}",
                "question_count": len(questions), "expires_at": value["expires_at"]}

    @app.get("/api/questions")
    async def questions(request: Request):
        value = await host(request)
        items = await asyncio.to_thread(service.questions, value)
        return [{"id": q.id, "text": q.text, "answers": q.answers,
                 "audio_url": q.audio_url(), "lab_url": q.lab_url(), "has_audio": q.has_audio,
                 "batch": q.batch, "seq": q.seq} for q in items]

    @app.get("/quiz_data/{path:path}")
    async def quiz_file(path: str, request: Request):
        value = await host(request)
        event_id = value["id"]
        # 音声/LAB のみ配信。CSV・txt等の一括取得口は設けない。
        items = await asyncio.to_thread(service.questions, value)
        allowed = {p for q in items for p in (q.wav, q.lab) if p}
        if path not in allowed:
            raise HTTPException(404, "ファイルがありません。")
        async with lock:
            if event_id not in asset_cache:
                directory = tempfile.TemporaryDirectory(prefix="quiz-assets-")
                try:
                    data = await asyncio.to_thread(objects.get, f"{event_id}/questions.zip")
                    await asyncio.to_thread(unpack, data, Path(directory.name))
                    asset_cache[event_id] = directory
                except Exception:
                    directory.cleanup()
                    raise
            # 展開中に終了した場合も拒否する。
            service.require(await asyncio.to_thread(service.read), event_id)
            return FileResponse(Path(asset_cache[event_id].name) / path,
                                media_type=mimetypes.guess_type(path)[0])

    ai_router = APIRouter(dependencies=[Depends(host)])
    ai_router.add_api_route("/api/llm/health", llm_health, methods=["GET"])
    ai_router.add_api_route("/api/llm/predict", llm_predict, methods=["POST"])
    app.include_router(ai_router)
    app.include_router(jev_router, dependencies=[Depends(host)])

    @app.websocket("/ws")
    async def websocket(socket: WebSocket):
        player_id: str | None = None
        connection_id = os.urandom(16).hex()
        event_id = ""
        is_host = False
        try:
            check_origin(socket, settings)
            async with lock:
                value = await asyncio.to_thread(service.read)
                event_id = socket.query_params.get("event", "")
                if socket.query_params.get("role") == "host":
                    credential = session(socket, settings, service.clock())
                    event_id = credential["event"]
                    is_host = True
                value = service.require(value, event_id)
                if not is_host and not secrets_equal(socket.query_params.get("key", ""), value["join_key"]):
                    raise HTTPException(403, "参加 URL が無効です。")
                await socket.accept()
                sockets[socket] = event_id
                deadlines[socket] = value["expires_at"]
            while True:
                raw = await socket.receive_text()
                if len(raw) > 65536:
                    raise HTTPException(413, "メッセージが大きすぎます。")
                try:
                    message = adapter.validate_json(raw)
                    if message.type == "join" and (is_host or player_id is not None):
                        raise HTTPException(409, "この接続は参加済みです。")
                    if message.type == "host_hello" and not is_host:
                        raise HTTPException(403, "主催者認証が必要です。")
                    async with lock:
                        def operation(room, document):
                            if player_id and message.type == "buzz":
                                if document.get("connections", {}).get(player_id) != connection_id:
                                    raise HTTPException(403, "新しい接続へ切り替わっています。")
                            result = execute(room, document, message, player_id, is_host)
                            if message.type == "join":
                                document.setdefault("connections", {})[result.id] = connection_id
                            return result
                        value, result = await asyncio.to_thread(service.change, event_id, operation,
                            take_over=is_host and message.type == "host_hello")
                        if message.type == "join":
                            player_id = result.id
                            manager.players[player_id] = socket
                            await manager.send(socket, WelcomeMessage(player_id=result.id, token=result.token, role="player"))
                        elif message.type == "host_hello":
                            manager.hosts.add(socket)
                            await manager.send(socket, WelcomeMessage(player_id="host", token="", role="host"))
                        elif message.type in ("buzz", "ai_buzz"):
                            if result.accepted:
                                room = load_room(value["room"], service.questions(value))
                                await manager.broadcast_raw(BuzzAcceptedMessage(round_id=room.round_id,
                                    player_id=result.player.id, name=room.display_names()[result.player.id]))
                            else:
                                await manager.send(socket, BuzzRejectedMessage(round_id=message.round_id,
                                    reason=result.reason or "wrong_phase"))
                        await publish(value)
                except ValidationError:
                    await manager.send(socket, ErrorMessage(code="invalid_message", message="メッセージの形式が不正です。"))
                except HTTPException as error:
                    code = "ended" if error.status_code == 410 else "forbidden" if error.status_code in (401, 403) else "invalid_operation"
                    await manager.send(socket, ErrorMessage(code=code, message=str(error.detail)))
                    if code == "ended":
                        await socket.close(code=4404)
                        break
                except Exception:
                    logger.exception("大会操作を保存できませんでした。")
                    await manager.send(socket, ErrorMessage(code="storage_unavailable", message="保存できませんでした。再接続してください。"))
                    await socket.close(code=1011)
                    break
        except HTTPException as error:
            await socket.close(code=4404 if error.status_code == 410 else 4403)
        except WebSocketDisconnect:
            pass
        finally:
            sockets.pop(socket, None)
            deadlines.pop(socket, None)
            last_version.pop(socket, None)
            manager.hosts.discard(socket)
            if player_id:
                if manager.players.get(player_id) is socket:
                    manager.players.pop(player_id, None)
                try:
                    async with lock:
                        def disconnect(room, document):
                            if document.get("connections", {}).get(player_id) == connection_id:
                                room.disconnect(player_id)
                        value, _ = await asyncio.to_thread(service.change, event_id, disconnect)
                        await publish(value)
                except Exception:
                    pass

    dist = REPO_ROOT / "web" / "dist"
    if dist.is_dir():
        @app.get("/")
        @app.get("/host")
        async def host_page():
            return FileResponse(dist / "host.html")

        @app.get("/player")
        async def player_page():
            return FileResponse(dist / "player.html")

        # 静的配信はビルド資産のみに限定し、別の HTML への迂回を作らない。
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")
    sound = REPO_ROOT / "sound"
    if sound.is_dir():
        app.mount("/sound", StaticFiles(directory=sound), name="sound")
    return app


def secrets_equal(first: str, second: str) -> bool:
    import secrets
    return secrets.compare_digest(first, second)


def from_environment() -> FastAPI:
    settings = Settings(password=os.environ["QUIZ_HOST_PASSWORD"],
                        session_secret=os.environ["QUIZ_SESSION_SECRET"],
                        public_url=os.environ["QUIZ_PUBLIC_URL"].rstrip("/"),
                        project=os.getenv("GOOGLE_CLOUD_PROJECT"),
                        bucket=os.environ["QUIZ_BUCKET"],
                        collection=os.getenv("QUIZ_COLLECTION", "quiz"),
                        database=os.getenv("QUIZ_DATABASE", "(default)"))
    return create_app(settings, FirestoreStore(settings.project, settings.collection, settings.database),
                      CloudStorageStore(settings.project, settings.bucket))
