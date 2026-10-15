"""外部保存境界を共有する複数プロセス相当の開催テスト。"""
from __future__ import annotations

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
    def __init__(self):
        self.values = {}
        self.lock = threading.Lock()
        self.fail = False

    def read(self, key):
        with self.lock:
            return copy.deepcopy(self.values.get(key))

    def update(self, key, change):
        with self.lock:
            value, result = change(copy.deepcopy(self.values.get(key)))
            if self.fail:
                raise OSError("storage unavailable")
            self.values[key] = copy.deepcopy(value)
            return result


class MemoryObjects:
    def __init__(self):
        self.values = {}

    def put(self, key, data):
        self.values[key] = data

    def get(self, key):
        return self.values[key]

    def delete(self, key):
        self.values.pop(key, None)


def archive(batch="csvonly", files=None):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as output:
        output.writestr("questions.csv", f"batch,seq,text,answer,alt_answers\n{batch},0,問題です,答え,\n{batch},1,次の問題,次の答え,\n")
        for key, value in (files or {}).items():
            output.writestr(key, value)
    return buffer.getvalue()


@pytest.fixture
def environment():
    settings = Settings("password", "s" * 32, "https://quiz.example")
    states, objects = MemoryStates(), MemoryObjects()
    return settings, states, objects


def test_zip_paths_and_partial_audio():
    assert len(validate(archive())) == 2
    for data in [archive("../outside"), archive(files={"../escape": "x"}),
                 archive(files={"/absolute": "x"}), archive(files={"csvonly/0-csvonly.wav": "x"})]:
        with pytest.raises(QuizDataError):
            validate(data)
    with pytest.raises(QuizDataError):
        validate(b"not a zip")
    info = zipfile.ZipInfo("symlink")
    info.external_attr = 0o120777 << 16
    with pytest.raises(QuizDataError):
        validate(archive(files={info: "questions.csv"}))


def test_atomic_start_restore_and_failed_save(environment):
    settings, states, objects = environment
    now = [1000.0]
    first = TournamentService(settings, states, objects, lambda: now[0])
    second = TournamentService(settings, states, objects, lambda: now[0])
    event = first.start(archive(), 24)
    with pytest.raises(HTTPException) as error:
        second.start(archive(), 24)
    assert error.value.status_code == 409
    assert len(objects.values) == 1
    def prepare(room, value):
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


def test_competing_buzz_and_stale_ai(environment):
    settings, states, objects = environment
    first = TournamentService(settings, states, objects)
    second = TournamentService(settings, states, objects)
    event = first.start(archive(), 24)
    def prepare(room, value):
        room.join("one", None)
        room.join("two", None)
        room.start_question()
    first.change(event["id"], prepare)
    def buzz(service, player):
        return service.change(event["id"], lambda room, value: execute(
            room, value, SimpleNamespace(type="buzz", round_id=1), player, False))[1].accepted
    with ThreadPoolExecutor() as pool:
        results = list(pool.map(lambda pair: buzz(*pair), [(first, "p_1"), (second, "p_2")]))
    assert results.count(True) == 1
    assert first.read()["room"]["phase"] == "buzzed"


def test_end_expiry_and_auth_rate(environment):
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


def test_http_authorization_and_lifecycle(environment):
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
        for path in ["/api/questions", "/api/llm/health", "/api/jev/health", "/quiz_data/questions.csv"]:
            assert anonymous.get(path).status_code == 401


def test_ai_context_and_confirmed_answer_survive_takeover(environment):
    settings, states, objects = environment
    now = [1000.0]
    first = TournamentService(settings, states, objects, lambda: now[0])
    second = TournamentService(settings, states, objects, lambda: now[0])
    event = first.start(archive(), 24)
    def command(service, **fields):
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


def test_session_is_bound_to_event_and_origin(environment):
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
