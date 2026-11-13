"""外部保存境界を共有する複数プロセス相当の開催テスト。"""
from __future__ import annotations

from typing import Any

import copy
import io
import json
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.cloud.app import create_app
from app.cloud.archive import validate
from app.cloud.service import Settings, TournamentService, execute
from app.cloud.snapshot import load_room
from app.quiz import QuizDataError


class MemoryStates:
    def __init__(self) -> None:
        self.values = {}
        self.lock = threading.Lock()
        self.fail = False

    def read(self, key: Any) -> Any:
        with self.lock:
            return copy.deepcopy(self.values.get(key))

    def update(self, key: Any, change: Any) -> Any:
        with self.lock:
            value, result = change(copy.deepcopy(self.values.get(key)))
            if self.fail:
                raise OSError("storage unavailable")
            self.values[key] = copy.deepcopy(value)
            return result


class MemoryObjects:
    def __init__(self) -> None:
        self.values = {}

    def put(self, key: Any, data: Any) -> Any:
        self.values[key] = data

    def get(self, key: Any) -> Any:
        return self.values[key]

    def delete(self, key: Any) -> Any:
        self.values.pop(key, None)


def archive(batch: Any="csvonly", files: Any=None) -> Any:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as output:
        output.writestr("questions.csv", f"batch,seq,text,answer,alt_answers\n{batch},0,問題です,答え,\n{batch},1,次の問題,次の答え,\n")
        for key, value in (files or {}).items():
            output.writestr(key, value)
    return buffer.getvalue()


@pytest.fixture
def environment() -> Any:
    settings = Settings("password", "s" * 32, "https://quiz.example")
    states, objects = MemoryStates(), MemoryObjects()
    return settings, states, objects


def test_zip_paths_and_partial_audio() -> None:
    assert len(validate(archive())) == 2
    for data in [archive("../outside"), archive(files={"../escape": "x"}),
                 archive(files={"/absolute": "x"}), archive(files={"csvonly/0-csvonly.wav": "x"})]:
        with pytest.raises(QuizDataError):
            validate(data)
    with pytest.raises(QuizDataError):
        validate(b"not a zip")
    with pytest.raises(QuizDataError):
        validate(archive(batch="a" * 150000))
    info = zipfile.ZipInfo("symlink")
    info.external_attr = 0o120777 << 16
    with pytest.raises(QuizDataError):
        validate(archive(files={info: "questions.csv"}))


def test_atomic_start_restore_and_failed_save(environment: Any) -> None:
    settings, states, objects = environment
    now = [1000.0]
    first = TournamentService(settings, states, objects, lambda: now[0])
    second = TournamentService(settings, states, objects, lambda: now[0])
    event = first.start(archive(), 24)
    with pytest.raises(HTTPException) as error:
        second.start(archive(), 24)
    assert error.value.status_code == 409
    assert len(objects.values) == 1
    def prepare(room: Any, value: Any) -> Any:
        room.join("one", None)
        room.join("two", None)
        room.join_ai("AI")
        room.start_question()
        room.buzz("p_1", room.round_id)
        return None
    first.change(event["id"], prepare)
    before = first.read()
    # 生きている実行主体がある間は別プロセスが接続しても停止しない。
    assert second.heartbeat()["paused"] is False
    now[0] += 16
    restored = second.heartbeat()
    assert restored["paused"] is True
    assert restored["room"]["round_id"] == before["room"]["round_id"] + 1
    assert restored["room"]["buzzed"] == "p_1"
    assert restored["room"]["deck"] == before["room"]["deck"]
    assert restored["expires_at"] == event["expires_at"]
    states.fail = True
    with pytest.raises(OSError):
        second.change(event["id"], lambda room, value: room.next_question())
    assert second.read() == restored


def test_competing_buzz_and_stale_ai(environment: Any) -> None:
    settings, states, objects = environment
    first = TournamentService(settings, states, objects)
    second = TournamentService(settings, states, objects)
    event = first.start(archive(), 24)
    def prepare(room: Any, value: Any) -> Any:
        room.join("one", None)
        room.join("two", None)
        room.start_question()
    first.change(event["id"], prepare)
    def buzz(service: Any, player: Any) -> Any:
        return service.change(event["id"], lambda room, value: execute(
            room, value, SimpleNamespace(type="buzz", round_id=1), player, False))[1].accepted
    with ThreadPoolExecutor() as pool:
        results = list(pool.map(lambda pair: buzz(*pair), [(first, "p_1"), (second, "p_2")]))
    assert results.count(True) == 1
    assert first.read()["room"]["phase"] == "buzzed"


def test_end_expiry_and_auth_rate(environment: Any) -> None:
    settings, states, objects = environment
    now = [1000.0]
    service = TournamentService(settings, states, objects, lambda: now[0])
    event = service.start(archive(), 1)
    now[0] = event["expires_at"]
    with pytest.raises(HTTPException) as error:
        service.change(event["id"], lambda room, value: room.join("late", None))
    assert error.value.status_code == 410
    assert service.heartbeat()["status"] == "ended"
    for _ in range(5):
        with pytest.raises(HTTPException) as error:
            service.check_password("wrong", "address")
        assert error.value.status_code == 401
    with pytest.raises(HTTPException) as error:
        service.check_password("password", "address")
    assert error.value.status_code == 429
    now[0] += 301
    service.check_password("password", "address")


def test_http_authorization_and_lifecycle(environment: Any) -> None:
    settings, states, objects = environment
    app = create_app(settings, states, objects)
    headers = {"Origin": settings.public_url, "X-Quiz-Request": "1"}
    with TestClient(app, base_url=settings.public_url) as client:
        assert client.get("/api/questions").status_code == 401
        assert client.post("/api/session", json={"password": "password"}).status_code == 403
        assert client.post("/api/tournament", content=archive(), headers=headers).status_code == 401
        response = client.post("/api/session", json={"password": "password"}, headers=headers)
        assert response.status_code == 200
        assert "HttpOnly" in response.headers["set-cookie"]
        assert "Secure" in response.headers["set-cookie"]
        response = client.post("/api/tournament", content=archive(), headers=headers)
        assert response.status_code == 200
        event_id = response.json()["id"]
        assert client.get("/api/questions").status_code == 200
        assert client.get("/api/room").json()["join_url"].startswith(settings.public_url)
        assert client.get("/quiz_data/questions.csv").status_code == 404
        join_url = client.get("/api/room").json()["join_url"]
        with client.websocket_connect("wss://quiz.example/ws?role=host", headers={"origin": settings.public_url}) as host:
            host.send_json({"type": "host_hello"})
            assert host.receive_json()["type"] == "welcome"
            assert host.receive_json()["type"] == "room_state"
            query = join_url.split("?", 1)[1]
            with client.websocket_connect("wss://quiz.example/ws?" + query, headers={"origin": settings.public_url}) as player:
                player.send_json({"type": "join", "name": "参加者"})
                assert player.receive_json()["type"] == "welcome"
                state = player.receive_json()
                assert state["question"] is None
                assert state["players"][0]["name"] == "参加者"
                player.send_json({"type": "start_question"})
                assert player.receive_json()["code"] == "forbidden"
                assert client.post("/api/tournament/end", headers=headers).status_code == 200
                # 終了通知より前の更新が入る可能性がある。
                while (message := player.receive_json())["type"] != "error":
                    pass
                assert message["code"] == "ended"
        assert client.get("/api/questions").status_code == 401
        client.post("/api/session", json={"password": "password"}, headers=headers)
        response = client.post("/api/tournament", content=archive(), headers=headers)
        assert response.json()["id"] != event_id
    with TestClient(app, base_url=settings.public_url) as anonymous:
        for path in ["/api/questions", "/api/llm/health", "/api/judge/health", "/quiz_data/questions.csv"]:
            assert anonymous.get(path).status_code == 401


def test_ai_context_and_confirmed_answer_survive_takeover(environment: Any) -> None:
    settings, states, objects = environment
    now = [1000.0]
    first = TournamentService(settings, states, objects, lambda: now[0])
    second = TournamentService(settings, states, objects, lambda: now[0])
    event = first.start(archive(), 24)
    def command(service: Any, **fields: Any) -> Any:
        return service.change(event["id"], lambda room, value: execute(room, value, SimpleNamespace(**fields), None, True))
    command(first, type="ai_toggle", enabled=True)
    command(first, type="start_question", question_id="csvonly/0")
    assert command(first, type="ai_buzz", round_id=1)[1].accepted
    command(first, type="ai_context", round_id=1, read_text="問題")
    now[0] += 16
    restored = second.heartbeat()
    assert restored["ai_enabled"] is True
    assert restored["ai_context"] == "問題"
    assert restored["room"]["buzzed"] is not None
    with pytest.raises(HTTPException):
        command(second, type="check", round_id=2)
    command(second, type="resume")
    # 再起動前の応答は受理しない。
    assert command(second, type="ai_answer", round_id=1, answer="古い", reason="", models=[], read_text="問題")[1] is False
    command(second, type="ai_answer", round_id=2, answer="答え", reason="合議", models=[], read_text="問題")
    command(second, type="check", round_id=2)
    command(second, type="judge", round_id=2, correct=True)
    before = second.read()
    now[0] += 16
    finished = first.heartbeat()
    assert finished["room"]["judgement"] == before["room"]["judgement"]
    assert finished["room"]["ai_answer"] == before["room"]["ai_answer"]
    assert finished["room"]["phase"] == "result"
    assert finished["paused"] is False


def test_session_is_bound_to_event_and_origin(environment: Any) -> None:
    settings, states, objects = environment
    app = create_app(settings, states, objects)
    headers = {"Origin": settings.public_url, "X-Quiz-Request": "1"}
    with TestClient(app, base_url=settings.public_url) as client:
        client.post('/api/session', json={"password": "password"}, headers=headers)
        client.post('/api/tournament', content=archive(), headers=headers)
        old_cookie = client.cookies.get('quiz_host')
        query = client.get('/api/room').json()['join_url'].split('?', 1)[1]
        from starlette.websockets import WebSocketDisconnect
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect('wss://quiz.example/ws?' + query,
                                          headers={"origin": "https://evil.example"}):
                pass
        assert error.value.code == 4403
        client.post('/api/tournament/end', headers=headers)
        client.post('/api/session', json={"password": "password"}, headers=headers)
        client.post('/api/tournament', content=archive(), headers=headers)
        client.cookies.set('quiz_host', old_cookie, domain='quiz.example', path='/')
        assert client.get('/api/questions').status_code == 410
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect('wss://quiz.example/ws?' + query,
                                          headers={"origin": settings.public_url}):
                pass
        assert error.value.code == 4404


def test_firestore_adapter_saves_mutations_and_skips_unchanged_values() -> None:
    from app.cloud.store import FirestoreStore
    value = {"count": 1}
    writes = []
    class Reference:
        def get(self, transaction: Any=None) -> Any:
            return SimpleNamespace(to_dict=lambda: copy.deepcopy(value))
    class Transaction:
        def set(self, ref: Any, updated: Any) -> Any:
            value.clear()
            value.update(copy.deepcopy(updated))
            writes.append(copy.deepcopy(updated))
    store = FirestoreStore.__new__(FirestoreStore)
    store._collection = SimpleNamespace(document=lambda key: Reference())
    store._client = SimpleNamespace(transaction=lambda **kwargs: Transaction())
    store._firestore = SimpleNamespace(transactional=lambda operation: operation)
    def increment(previous: Any) -> Any:
        previous['count'] += 1
        return previous, previous['count']
    assert store.update('auth-test', increment) == 2
    assert writes == [{"count": 2}]
    assert store.update('auth-test', lambda previous: (previous, 'unchanged')) == 'unchanged'
    assert len(writes) == 1


def test_authenticated_audio_delivery_and_expired_socket(environment: Any) -> None:
    settings, states, objects = environment
    app = create_app(settings, states, objects)
    headers = {"Origin": settings.public_url, "X-Quiz-Request": "1"}
    data = archive(files={
        'csvonly/0-csvonly.wav': b'RIFF' + b'0' * 32,
        'csvonly/0-csvonly.txt': '問題です',
        'csvonly/0-csvonly.lab': '0 10000000 a\n',
    })
    with TestClient(app, base_url=settings.public_url) as client:
        client.post('/api/session', json={"password": "password"}, headers=headers)
        client.post('/api/tournament', content=data, headers=headers).raise_for_status()
        audio = client.get('/quiz_data/csvonly/0-csvonly.wav', headers={"Range": "bytes=0-3"})
        assert audio.status_code == 206
        assert audio.content == b'RIFF'
        assert audio.headers['cache-control'] == 'no-store'
        lab = client.get('/quiz_data/csvonly/0-csvonly.lab')
        assert lab.status_code == 200
        assert client.get('/quiz_data/csvonly/0-csvonly.txt').status_code == 404
        query = client.get('/api/room').json()['join_url'].split('?', 1)[1]
        with client.websocket_connect('wss://quiz.example/ws?' + query,
                                      headers={"origin": settings.public_url}) as player:
            player.send_json({"type": "join", "name": "期限検証"})
            assert player.receive_json()['type'] == 'welcome'
            assert player.receive_json()['type'] == 'room_state'
            # ストアのTTL削除ではなく、各操作のサーバ時刻検証で拒否する。
            now = app.state.service.clock()
            app.state.service.clock = lambda: now + 86401
            player.send_json({"type": "buzz", "round_id": 0})
            assert player.receive_json()['code'] == 'ended'
        assert client.get('/quiz_data/csvonly/0-csvonly.wav').status_code == 401


def test_new_host_takes_over_while_previous_revision_is_alive(environment: Any) -> None:
    settings, states, objects = environment
    first = TournamentService(settings, states, objects)
    second = TournamentService(settings, states, objects)
    event = first.start(archive(), 24)
    def prepare(room: Any, value: Any) -> Any:
        room.join('参加者', None)
        room.start_question()
        room.buzz('p_1', room.round_id)
    first.change(event['id'], prepare)
    # 旧リビジョンが生存しリースを更新し続ける場合も、主催者は新プロセスへ復帰できる。
    value, _ = second.change(event['id'], lambda room, document: execute(
        room, document, SimpleNamespace(type='host_hello'), None, True), take_over=True)
    assert value['paused'] is True
    assert value['owner'] == second.owner
    assert value['room']['round_id'] == 2
    assert value['room']['buzzed'] == 'p_1'
    assert first.heartbeat()['owner'] == second.owner
    with pytest.raises(HTTPException):
        first.change(event['id'], lambda room, document: execute(
            room, document, SimpleNamespace(type='check', round_id=2), None, True))
    second.change(event['id'], lambda room, document: execute(
        room, document, SimpleNamespace(type='resume'), None, True))
    assert first.read()['paused'] is False


def _receive_until(websocket: Any, message_type: str) -> Any:
    while True:
        message = websocket.receive_json()
        if message["type"] == message_type:
            return message


def test_cloud_websocket_rejoin_renames_with_own_token(environment: Any) -> None:
    """参加済み接続は本人トークン付きの再 join で名前だけ更新できる。"""
    settings, states, objects = environment
    app = create_app(settings, states, objects)
    headers = {"Origin": settings.public_url, "X-Quiz-Request": "1"}
    with TestClient(app, base_url=settings.public_url) as client:
        client.post("/api/session", json={"password": "password"}, headers=headers)
        client.post("/api/tournament", content=archive(), headers=headers)
        query = client.get("/api/room").json()["join_url"].split("?", 1)[1]
        with client.websocket_connect(
            "wss://quiz.example/ws?" + query, headers={"origin": settings.public_url}
        ) as player:
            player.send_json({"type": "join", "name": "旧名"})
            welcome = _receive_until(player, "welcome")
            state = _receive_until(player, "room_state")
            assert len(state["players"]) == 1
            assert state["players"][0]["name"] == "旧名"

            player.send_json({"type": "join", "name": "新名", "token": welcome["token"]})
            renamed = _receive_until(player, "welcome")
            assert renamed["player_id"] == welcome["player_id"]
            updated = _receive_until(player, "room_state")
            assert len(updated["players"]) == 1
            assert updated["players"][0]["id"] == welcome["player_id"]
            assert updated["players"][0]["name"] == "新名"


def test_cloud_websocket_rejoin_rejects_without_own_token(environment: Any) -> None:
    """トークン無し・他人のトークン・出題者からの join は 409 相当で拒否する。"""
    settings, states, objects = environment
    app = create_app(settings, states, objects)
    headers = {"Origin": settings.public_url, "X-Quiz-Request": "1"}
    with TestClient(app, base_url=settings.public_url) as client:
        client.post("/api/session", json={"password": "password"}, headers=headers)
        client.post("/api/tournament", content=archive(), headers=headers)
        query = client.get("/api/room").json()["join_url"].split("?", 1)[1]

        with client.websocket_connect(
            "wss://quiz.example/ws?role=host", headers={"origin": settings.public_url}
        ) as host:
            host.send_json({"type": "host_hello"})
            _receive_until(host, "welcome")
            _receive_until(host, "room_state")
            host.send_json({"type": "join", "name": "主催者"})
            error = _receive_until(host, "error")
            assert error["code"] == "invalid_operation"
            assert error["message"] == "この接続は参加済みです。"
            assert len(states.read("current")["room"]["players"]) == 0

        with client.websocket_connect(
            "wss://quiz.example/ws?" + query, headers={"origin": settings.public_url}
        ) as first:
            first.send_json({"type": "join", "name": "一人目"})
            first_welcome = _receive_until(first, "welcome")
            _receive_until(first, "room_state")

            with client.websocket_connect(
                "wss://quiz.example/ws?" + query, headers={"origin": settings.public_url}
            ) as second:
                second.send_json({"type": "join", "name": "二人目"})
                second_welcome = _receive_until(second, "welcome")
                _receive_until(second, "room_state")
                # 一人目にも二人目参加の room_state が届く
                _receive_until(first, "room_state")

                first.send_json({"type": "join", "name": "なりすまし"})
                error = _receive_until(first, "error")
                assert error["code"] == "invalid_operation"
                assert error["message"] == "この接続は参加済みです。"

                first.send_json({
                    "type": "join",
                    "name": "なりすまし",
                    "token": second_welcome["token"],
                })
                error = _receive_until(first, "error")
                assert error["code"] == "invalid_operation"
                assert error["message"] == "この接続は参加済みです。"

                names = {player["name"] for player in states.read("current")["room"]["players"]}
                assert names == {"一人目", "二人目"}
                assert first_welcome["player_id"] != second_welcome["player_id"]


def test_cloud_websocket_rejoin_rejects_after_connection_takeover(environment: Any) -> None:
    """別タブが接続を奪った後、古いタブからの再 join は拒否し、新接続の早押しは通る。"""
    settings, states, objects = environment
    app = create_app(settings, states, objects)
    headers = {"Origin": settings.public_url, "X-Quiz-Request": "1"}
    with TestClient(app, base_url=settings.public_url) as client:
        client.post("/api/session", json={"password": "password"}, headers=headers)
        client.post("/api/tournament", content=archive(), headers=headers)
        query = client.get("/api/room").json()["join_url"].split("?", 1)[1]

        with client.websocket_connect(
            "wss://quiz.example/ws?role=host", headers={"origin": settings.public_url}
        ) as host:
            host.send_json({"type": "host_hello"})
            _receive_until(host, "welcome")
            _receive_until(host, "room_state")

            with client.websocket_connect(
                "wss://quiz.example/ws?" + query, headers={"origin": settings.public_url}
            ) as old_tab:
                old_tab.send_json({"type": "join", "name": "たけ"})
                welcome = _receive_until(old_tab, "welcome")
                _receive_until(old_tab, "room_state")
                _receive_until(host, "room_state")

                with client.websocket_connect(
                    "wss://quiz.example/ws?" + query, headers={"origin": settings.public_url}
                ) as new_tab:
                    new_tab.send_json({"type": "join", "name": "たけ", "token": welcome["token"]})
                    new_welcome = _receive_until(new_tab, "welcome")
                    assert new_welcome["player_id"] == welcome["player_id"]
                    _receive_until(new_tab, "room_state")
                    _receive_until(old_tab, "room_state")
                    _receive_until(host, "room_state")

                    old_tab.send_json({
                        "type": "join",
                        "name": "奪還",
                        "token": welcome["token"],
                    })
                    error = _receive_until(old_tab, "error")
                    assert error["code"] == "invalid_operation"
                    assert error["message"] == "この接続は参加済みです。"

                    host.send_json({"type": "start_question"})
                    state = _receive_until(new_tab, "room_state")
                    round_id = state["round_id"]
                    new_tab.send_json({
                        "type": "buzz",
                        "round_id": round_id,
                        "client_sent_at": 1,
                    })
                    accepted = _receive_until(new_tab, "buzz_accepted")
                    assert accepted["player_id"] == welcome["player_id"]
