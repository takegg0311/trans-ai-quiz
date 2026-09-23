"""WebSocket 経由の統合テスト。

room.py の単体テストでは検証できない、権限チェックとメッセージの往復を確認する。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocket

from app.quiz import Question
from app.room import Room
from app.ws import ConnectionManager, router

HOST_TOKEN = "test-host-token"


def make_question(seq: int) -> Question:
    return Question(
        id=f"20260820/{seq}",
        batch="20260820",
        seq=seq,
        wav=f"20260820/{seq}.wav",
        txt=f"20260820/{seq}.txt",
        lab=f"20260820/{seq}.lab",
        text=f"問題{seq}",
        answers=[f"答え{seq}"],
    )


@pytest.fixture
def client() -> Iterator[TestClient]:
    """WebSocket だけを載せた最小のアプリ。

    main.py を使うと quiz_data の実データに依存してしまうため、
    ここでは router と状態だけを組み立てる。
    """
    app = FastAPI()
    app.state.questions = [make_question(0), make_question(1)]
    app.state.host_token = HOST_TOKEN
    app.state.room = Room(questions=app.state.questions)
    app.state.connections = ConnectionManager()
    app.include_router(router)

    with TestClient(app) as test_client:
        yield test_client


def receive_until(
    websocket: WebSocket,
    message_type: str,
    *,
    where: Callable[[dict[str, Any]], bool] | None = None,
    limit: int = 30,
) -> dict[str, Any]:
    """条件を満たすメッセージが来るまで読み飛ばす。

    参加や状態変化のたびに room_state がブロードキャストされ、しかも
    TestClient は接続ごとに別スレッドで動くため到着順は決め打ちできない。
    「何通目か」ではなく「どういう内容か」で待つ。
    """
    for _ in range(limit):
        message = json.loads(websocket.receive_text())
        if message["type"] != message_type:
            continue
        if where is None or where(message):
            return message
    raise AssertionError(f"条件を満たす {message_type} が届きませんでした")


class TestJoin:
    def test_参加すると_welcome_が返る(self, client: TestClient) -> None:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({"type": "join", "name": "たけ"})
            welcome = receive_until(websocket, "welcome")

            assert welcome["role"] == "player"
            assert welcome["player_id"] == "p_1"
            assert welcome["token"]

    def test_参加すると全員へ状態が配られる(self, client: TestClient) -> None:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({"type": "join", "name": "たけ"})
            state = receive_until(websocket, "room_state")

            assert state["phase"] == "idle"
            assert [player["name"] for player in state["players"]] == ["たけ"]

    def test_token_で同じ参加者として復帰する(self, client: TestClient) -> None:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({"type": "join", "name": "たけ"})
            token = receive_until(websocket, "welcome")["token"]

        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({"type": "join", "name": "たけ", "token": token})
            welcome = receive_until(websocket, "welcome")

            assert welcome["player_id"] == "p_1"

    def test_回答者には問題文を送らない(self, client: TestClient) -> None:
        with (
            client.websocket_connect("/ws") as host,
            client.websocket_connect("/ws") as player,
        ):
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            receive_until(host, "welcome")
            player.send_json({"type": "join", "name": "たけ"})
            receive_until(player, "welcome")

            host.send_json({"type": "start_question"})

            def is_reading(message: dict[str, Any]) -> bool:
                return bool(message["phase"] == "reading")

            host_state = receive_until(host, "room_state", where=is_reading)
            player_state = receive_until(player, "room_state", where=is_reading)

            assert host_state["question"] is not None
            # 読み上げ中は出題者にも正解を送らない（投影は参加者も見る）
            assert host_state["question"]["answers"] is None
            assert player_state["question"] is None


class TestHostAuth:
    def test_正しいトークンで出題者になれる(self, client: TestClient) -> None:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            welcome = receive_until(websocket, "welcome")

            assert welcome["role"] == "host"

    def test_違うトークンは拒否される(self, client: TestClient) -> None:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({"type": "host_hello", "host_token": "でたらめ"})
            error = receive_until(websocket, "error")

            assert error["code"] == "forbidden"

    @pytest.mark.parametrize(
        "message",
        [
            {"type": "start_question"},
            {"type": "reading_ended", "round_id": 1},
            {"type": "time_up", "round_id": 1},
            {"type": "check", "round_id": 1},
            {"type": "judge", "round_id": 1, "correct": True},
            {"type": "release", "round_id": 1},
            {"type": "next"},
        ],
    )
    def test_回答者は出題者の操作をできない(
        self, client: TestClient, message: dict[str, Any]
    ) -> None:
        """回答者が起こせる遷移は buzz ひとつだけ。"""
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({"type": "join", "name": "たけ"})
            receive_until(websocket, "welcome")

            websocket.send_json(message)
            error = receive_until(websocket, "error")

            assert error["code"] == "forbidden"


class TestBuzz:
    def test_最初の一人だけが_accepted_になる(self, client: TestClient) -> None:
        with (
            client.websocket_connect("/ws") as host,
            client.websocket_connect("/ws") as first,
            client.websocket_connect("/ws") as second,
        ):
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            first.send_json({"type": "join", "name": "たけ"})
            second.send_json({"type": "join", "name": "はな"})
            for socket in (host, first, second):
                receive_until(socket, "welcome")

            host.send_json({"type": "start_question"})
            round_id = receive_until(
                host, "room_state", where=lambda m: m["phase"] == "reading"
            )["round_id"]

            first.send_json({"type": "buzz", "round_id": round_id})
            accepted = receive_until(first, "buzz_accepted")

            second.send_json({"type": "buzz", "round_id": round_id})
            rejected = receive_until(second, "buzz_rejected")

            assert accepted["name"] == "たけ"
            assert rejected["reason"] == "too_late"

    def test_buzz_は全員へ配られる(self, client: TestClient) -> None:
        """押されたことは押していない人の画面にも出る必要がある。"""
        with (
            client.websocket_connect("/ws") as host,
            client.websocket_connect("/ws") as first,
            client.websocket_connect("/ws") as second,
        ):
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            first.send_json({"type": "join", "name": "たけ"})
            second.send_json({"type": "join", "name": "はな"})
            for socket in (host, first, second):
                receive_until(socket, "welcome")

            host.send_json({"type": "start_question"})
            round_id = receive_until(
                host, "room_state", where=lambda m: m["phase"] == "reading"
            )["round_id"]

            first.send_json({"type": "buzz", "round_id": round_id})

            assert receive_until(host, "buzz_accepted")["name"] == "たけ"
            assert receive_until(second, "buzz_accepted")["name"] == "たけ"

    def test_参加前の_buzz_は拒否される(self, client: TestClient) -> None:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({"type": "buzz", "round_id": 1})
            error = receive_until(websocket, "error")

            assert error["code"] == "not_joined"

    def test_古いラウンドの_buzz_は弾かれる(self, client: TestClient) -> None:
        with (
            client.websocket_connect("/ws") as host,
            client.websocket_connect("/ws") as player,
        ):
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            player.send_json({"type": "join", "name": "たけ"})
            receive_until(host, "welcome")
            receive_until(player, "welcome")

            host.send_json({"type": "start_question"})
            round_id = receive_until(
                host, "room_state", where=lambda m: m["phase"] == "reading"
            )["round_id"]

            player.send_json({"type": "buzz", "round_id": round_id - 1})
            rejected = receive_until(player, "buzz_rejected")

            assert rejected["reason"] == "stale_round"


class TestFlow:
    def test_出題から判定までひと通り流れる(self, client: TestClient) -> None:
        with (
            client.websocket_connect("/ws") as host,
            client.websocket_connect("/ws") as player,
        ):
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            player.send_json({"type": "join", "name": "たけ"})
            receive_until(host, "welcome")
            receive_until(player, "welcome")

            host.send_json({"type": "start_question"})
            round_id = receive_until(
                host, "room_state", where=lambda m: m["phase"] == "reading"
            )["round_id"]

            player.send_json({"type": "buzz", "round_id": round_id})
            receive_until(host, "buzz_accepted")
            buzzed = receive_until(host, "room_state", where=lambda m: m["phase"] == "buzzed")
            # 回答権を得ただけでは正解を出さない
            assert buzzed["question"]["answers"] is None

            host.send_json({"type": "check", "round_id": round_id})
            checked = receive_until(host, "room_state", where=lambda m: m["phase"] == "check")
            # 正解を確認する段になって初めて送られる
            assert checked["question"]["answers"]

            host.send_json({"type": "judge", "round_id": round_id, "correct": True})
            judged = receive_until(host, "room_state", where=lambda m: m["phase"] == "result")
            assert judged["judgement"]["correct"] is True
            assert judged["judgement"]["name"] == "たけ"

            host.send_json({"type": "next"})
            receive_until(host, "room_state", where=lambda m: m["phase"] == "idle")

    def test_押し間違いを解除すると本人がまた押せる(self, client: TestClient) -> None:
        """誤って押してしまった事故の逃げ口。判定を経ていないので罰しない。"""
        with (
            client.websocket_connect("/ws") as host,
            client.websocket_connect("/ws") as player,
        ):
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            player.send_json({"type": "join", "name": "たけ"})
            receive_until(host, "welcome")
            receive_until(player, "welcome")

            host.send_json({"type": "start_question"})
            round_id = receive_until(
                host, "room_state", where=lambda m: m["phase"] == "reading"
            )["round_id"]

            player.send_json({"type": "buzz", "round_id": round_id})
            receive_until(host, "buzz_accepted")

            host.send_json({"type": "release", "round_id": round_id})
            released = receive_until(
                host,
                "room_state",
                where=lambda m: m["phase"] == "reading" and m["buzzed"] is None,
            )
            assert [p for p in released["players"] if p["locked_out"]] == []

            # 同じラウンド内の 2 度目の buzz なので round_id では区別できない。
            # 1 度目の buzz_accepted がキューに残っているため round_id ではなく
            # 「buzzed が自分になった room_state」で待つ。
            player.send_json({"type": "buzz", "round_id": round_id})
            receive_until(host, "room_state", where=lambda m: m["phase"] == "buzzed")

    def test_読み切っても締め切るまで押せる(self, client: TestClient) -> None:
        """読み切ってから数秒は押させるのが通例のため。"""
        with (
            client.websocket_connect("/ws") as host,
            client.websocket_connect("/ws") as player,
        ):
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            player.send_json({"type": "join", "name": "たけ"})
            receive_until(host, "welcome")
            receive_until(player, "welcome")

            host.send_json({"type": "start_question"})
            round_id = receive_until(
                host, "room_state", where=lambda m: m["phase"] == "reading"
            )["round_id"]

            # 音声を読み切っても締め切らない
            host.send_json({"type": "reading_ended", "round_id": round_id})
            ended = receive_until(
                host, "room_state", where=lambda m: m["phase"] == "readingEnded"
            )
            assert ended["question"]["answers"] is None

            # まだ押せる
            player.send_json({"type": "buzz", "round_id": round_id})
            receive_until(host, "buzz_accepted")

    def test_誰も押さずに締め切ると正解が出る(self, client: TestClient) -> None:
        with (
            client.websocket_connect("/ws") as host,
            client.websocket_connect("/ws") as player,
        ):
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            player.send_json({"type": "join", "name": "たけ"})
            receive_until(host, "welcome")
            receive_until(player, "welcome")

            host.send_json({"type": "start_question"})
            round_id = receive_until(
                host, "room_state", where=lambda m: m["phase"] == "reading"
            )["round_id"]

            host.send_json({"type": "reading_ended", "round_id": round_id})
            receive_until(host, "room_state", where=lambda m: m["phase"] == "readingEnded")

            host.send_json({"type": "time_up", "round_id": round_id})
            timed_up = receive_until(host, "room_state", where=lambda m: m["phase"] == "timeUp")
            assert timed_up["question"]["answers"]

            # 締め切った後は押せない
            player.send_json({"type": "buzz", "round_id": round_id})
            assert receive_until(player, "buzz_rejected")["reason"] == "wrong_phase"

    def test_切断しても一覧に残る(self, client: TestClient) -> None:
        with client.websocket_connect("/ws") as host:
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            receive_until(host, "welcome")

            with client.websocket_connect("/ws") as player:
                player.send_json({"type": "join", "name": "たけ"})
                receive_until(player, "welcome")

            state = receive_until(
                host,
                "room_state",
                where=lambda m: len(m["players"]) == 1
                and m["players"][0]["connected"] is False,
            )
            assert state["players"][0]["name"] == "たけ"


class TestInvalidMessage:
    def test_不正な_json_は_error_を返す(self, client: TestClient) -> None:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_text("これは JSON ではない")
            error = receive_until(websocket, "error")

            assert error["code"] == "invalid_message"

    def test_未知の_type_は_error_を返す(self, client: TestClient) -> None:
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({"type": "存在しない操作"})
            error = receive_until(websocket, "error")

            assert error["code"] == "invalid_message"


class TestAiPlayer:
    """AI 参加者の登録と回答の受け渡し。権限チェックが主眼。"""

    def test_出題者は_ai_を登録できる(self, client: TestClient) -> None:
        with client.websocket_connect("/ws") as host:
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            receive_until(host, "welcome")
            host.send_json({"type": "ai_join", "name": "AI"})

            state = receive_until(
                host, "room_state", where=lambda m: len(m["players"]) == 1
            )

            assert state["players"][0]["is_ai"] is True

    def test_回答者は_ai_を登録できない(self, client: TestClient) -> None:
        # 回答者が勝手に AI を増やせると投影の一覧が荒れる
        with client.websocket_connect("/ws") as player:
            player.send_json({"type": "join", "name": "たけ"})
            receive_until(player, "welcome")
            player.send_json({"type": "ai_join", "name": "AI"})

            error = receive_until(player, "error")

            assert error["code"] == "forbidden"

    def test_回答者は_ai_の回答を送れない(self, client: TestClient) -> None:
        with client.websocket_connect("/ws") as player:
            player.send_json({"type": "join", "name": "たけ"})
            receive_until(player, "welcome")
            player.send_json(
                {"type": "ai_answer", "round_id": 1, "answer": "富士山", "reason": ""}
            )

            error = receive_until(player, "error")

            assert error["code"] == "forbidden"

    def test_ai_の回答は押した直後から出て正解は_check_まで出ない(
        self, client: TestClient
    ) -> None:
        """AI の回答は正解より早く出す。**正解の露出は変えない。**

        AI の回答は「AI が何と答えたか」であって正解ではなく、AI が押した
        時点でそのラウンドの解答権は確定している（ダブルチャンスは無い）。
        投影を見ている参加者が読んでも得をしないため、押した直後から出す。

        一方で正解を早く出すと、それを読んで答えられてしまう。
        2 つが別の制御になっていることをここで確かめる。
        """
        with client.websocket_connect("/ws") as host:
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            welcome = receive_until(host, "welcome")
            assert welcome["role"] == "host"

            host.send_json({"type": "ai_join", "name": "AI"})
            state = receive_until(
                host, "room_state", where=lambda m: len(m["players"]) == 1
            )
            ai_id = state["players"][0]["id"]

            host.send_json({"type": "start_question"})
            state = receive_until(host, "room_state", where=lambda m: m["phase"] == "reading")
            round_id = state["round_id"]

            host.send_json({"type": "ai_buzz", "round_id": round_id, "judged_length": 12})
            accepted = receive_until(host, "buzz_accepted")
            assert accepted["player_id"] == ai_id

            host.send_json(
                {
                    "type": "ai_answer",
                    "round_id": round_id,
                    "answer": "富士山",
                    "reason": "2/3 が同じ回答",
                    "models": [],
                }
            )
            # ai_answer が載った room_state を待つ。phase だけで待つと、
            # 合議が届く前のブロードキャストを拾ってしまう
            state = receive_until(
                host,
                "room_state",
                where=lambda m: m["phase"] == "buzzed" and m["ai_answer"] is not None,
            )

            # AI の回答は buzzed から出る
            assert state["ai_answer"]["answer"] == "富士山"
            # 正解はまだ出ない
            assert state["question"]["answers"] is None

            host.send_json({"type": "check", "round_id": round_id})
            state = receive_until(host, "room_state", where=lambda m: m["phase"] == "check")

            # check で正解が出る。AI の回答は出たまま
            # （どの問題が抽選されるかはシャッフル次第なので、内容は問わない）
            assert state["question"]["answers"] is not None
            assert state["ai_answer"]["answer"] == "富士山"

    def test_ai_が参加していなければ_ai_buzz_は弾く(self, client: TestClient) -> None:
        with client.websocket_connect("/ws") as host:
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            receive_until(host, "welcome")
            host.send_json({"type": "start_question"})
            state = receive_until(host, "room_state", where=lambda m: m["phase"] == "reading")

            host.send_json({"type": "ai_buzz", "round_id": state["round_id"]})
            error = receive_until(host, "error")

            assert error["code"] == "not_joined"

    def test_回答者は_ai_buzz_を送れない(self, client: TestClient) -> None:
        """buzz に player_id を載せる方式にしなかった理由の確認。

        出題者が任意の参加者になりすまして押せる形にはしていない。
        """
        with client.websocket_connect("/ws") as player:
            player.send_json({"type": "join", "name": "たけ"})
            receive_until(player, "welcome")
            player.send_json({"type": "ai_buzz", "round_id": 1})

            error = receive_until(player, "error")

            assert error["code"] == "forbidden"

    def test_人間が先に押していれば_ai_buzz_は弾かれる(self, client: TestClient) -> None:
        with (
            client.websocket_connect("/ws") as host,
            client.websocket_connect("/ws") as player,
        ):
            host.send_json({"type": "host_hello", "host_token": HOST_TOKEN})
            receive_until(host, "welcome")
            host.send_json({"type": "ai_join", "name": "AI"})
            player.send_json({"type": "join", "name": "たけ"})
            receive_until(player, "welcome")

            host.send_json({"type": "start_question"})
            state = receive_until(host, "room_state", where=lambda m: m["phase"] == "reading")
            round_id = state["round_id"]

            player.send_json({"type": "buzz", "round_id": round_id})
            receive_until(player, "buzz_accepted")

            host.send_json({"type": "ai_buzz", "round_id": round_id})
            rejected = receive_until(host, "buzz_rejected")

            assert rejected["reason"] == "too_late"
