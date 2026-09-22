"""FastAPI アプリ本体。

起動時に questions.csv を検証する。問題があってもサーバは起動するが、
オンライン版の入口（/ws /host /player）だけを閉じる。PoC から LLM 中継
（/api/llm）だけを使う場合に、出題データが無くても起動できるようにするため。

エラーを握り潰して問題 0 件のまま出題できてしまうと、原因が分からないまま
遊べない状態になる。そのため入口は明示的に 503 で閉じ、起動時に理由を出す。

静的ファイル（web/dist と quiz_data）の配信もここが担う。

注意: uvicorn は --workers 1 で起動すること。
ルーム状態はプロセス内のメモリに持つため、ワーカーを増やすと状態が分裂する。
"""

from __future__ import annotations

import secrets
import socket
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .jev.router import router as jev_router
from .llm.router import router as llm_router
from .quiz import QUIZ_DATA_DIR, REPO_ROOT, QuizDataError, Question, load_questions
from .room import Room
from .ws import ConnectionManager, router as ws_router

WEB_DIST_DIR = REPO_ROOT / "web" / "dist"

# 出題者だけが操作できるようにするためのトークン。
# 同一 LAN のクローズドな利用が前提なので、起動ごとの乱数 1 本で足りる。
HOST_TOKEN = secrets.token_urlsafe(16)


def detect_lan_ip() -> str:
    """参加者に配る URL に載せる LAN IP を調べる。

    外へパケットは出さず、ルーティングテーブル上の送信元アドレスだけを得る。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.connect(("8.8.8.8", 80))
            return str(sock.getsockname()[0])
        except OSError:
            return "127.0.0.1"


def _print_banner(port: int, question_count: int, quiz_error: str | None) -> None:
    print()

    if quiz_error is not None:
        # 出題はできないが LLM 中継だけは使える。何が起きているかを最初に出す。
        print("  [quiz_data] 出題データを読み込めませんでした。オンライン版は使えません。")
        for line in quiz_error.splitlines():
            print(f"    {line}")
        print()
        print("  LLM 中継のみ利用可: http://localhost:{}/api/llm/health".format(port))
        print()
        return

    lan_ip = detect_lan_ip()
    print(f"  問題数: {question_count} 問")
    print()
    print(f"  出題者用: http://localhost:{port}/host?token={HOST_TOKEN}")
    print(f"  参加者用: http://{lan_ip}:{port}/player")
    print()


def _load_questions_or_warn() -> tuple[list[Question], str | None]:
    """検証に失敗しても起動は続け、失敗の内容を返す。

    ズレたまま出題されるとクイズを遊ぶまで気づけないため、失敗した場合は
    オンライン版の入口を閉じる（_require_quiz_data）。ただしサーバ自体は
    起動させる。PoC から LLM 中継だけを使う場合、出題データの有無は無関係で、
    ここで止めると LLM の疎通確認すらできなくなるため。
    """
    try:
        return load_questions(), None
    except QuizDataError as error:
        print(f"[quiz_data] {error}", file=sys.stderr)
        return [], str(error)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _print_banner(_current_port(), len(app.state.questions), app.state.quiz_error)
    yield


def _current_port() -> int:
    """バナー表示用にポートを拾う。uvicorn の引数から取れなければ既定値。"""
    for index, arg in enumerate(sys.argv):
        if arg == "--port" and index + 1 < len(sys.argv):
            try:
                return int(sys.argv[index + 1])
            except ValueError:
                break
    return 8000


app = FastAPI(title="trans-ai-quiz", lifespan=lifespan)
app.state.questions, app.state.quiz_error = _load_questions_or_warn()
app.state.host_token = HOST_TOKEN
# ルーム状態はプロセス内のメモリに持つ。--workers は 1 固定であること。
# 出題データが無い場合はルームを作らない（オンライン版は閉じるため）。
app.state.room = Room(questions=app.state.questions) if app.state.quiz_error is None else None
app.state.connections = ConnectionManager()


def _require_quiz_data() -> None:
    """出題データが無ければオンライン版を使わせない。

    問題 0 件のルームで出題できてしまうと、原因が分からないまま遊べない
    状態になる。LLM 中継（/api/llm）はこの制限を受けない。
    """
    if app.state.quiz_error is not None:
        raise HTTPException(
            status_code=503,
            detail="出題データを読み込めていないため、オンライン版は利用できません。"
            "サーバの起動ログを確認してください。",
        )


# LLM 予測の中継。出題データの有無に関わらず使える。
app.include_router(llm_router)

# Jev による早押し判定。こちらも出題データに依存しない。
app.include_router(jev_router)

app.include_router(ws_router)


@app.get("/api/questions")
async def list_questions() -> list[dict[str, object]]:
    """問題一覧を返す。動作確認用。

    回答者へ配る情報ではないため、出題者画面と開発時の確認にのみ使う。
    """
    _require_quiz_data()
    questions: list[Question] = app.state.questions
    return [
        {
            "id": question.id,
            "batch": question.batch,
            "seq": question.seq,
            "text": question.text,
            "answers": question.answers,
            "audio_url": question.audio_url(),
            "lab_url": question.lab_url(),
            "has_audio": question.has_audio,
        }
        for question in questions
    ]


@app.get("/api/room")
async def room_info() -> dict[str, object]:
    """参加用 URL を返す。出題者画面が QR を描くために使う。"""
    _require_quiz_data()
    return {
        "lan_ip": detect_lan_ip(),
        "port": _current_port(),
        "join_url": f"http://{detect_lan_ip()}:{_current_port()}/player",
        "question_count": len(app.state.questions),
    }


# 出題音声・音素ラベルの配信。PoC と共有しているルートの quiz_data を直接見る。
app.mount("/quiz_data", StaticFiles(directory=QUIZ_DATA_DIR), name="quiz_data")

# ジングル SE
_sound_dir = REPO_ROOT / "sound"
if _sound_dir.is_dir():
    app.mount("/sound", StaticFiles(directory=_sound_dir), name="sound")


# フロントエンドの配信。本番は 1 ポートに寄せ、参加者に配る URL を 1 つにする。
# 開発時は Vite dev server 側から /api・/ws をプロキシするため、ここは無くてよい。
if WEB_DIST_DIR.is_dir():

    @app.get("/host")
    async def host_page() -> FileResponse:
        _require_quiz_data()
        return FileResponse(WEB_DIST_DIR / "host.html")

    @app.get("/player")
    async def player_page() -> FileResponse:
        _require_quiz_data()
        return FileResponse(WEB_DIST_DIR / "player.html")

    app.mount("/", StaticFiles(directory=WEB_DIST_DIR), name="web")
