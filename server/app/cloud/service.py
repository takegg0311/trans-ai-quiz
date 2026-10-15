"""大会単位の状態遷移。外部保存の確定前にはクライアントへ配信しない。"""
from __future__ import annotations

import copy
import hashlib
import json
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar

from fastapi import HTTPException

from ..protocol import AiAnswerView
from ..quiz import Question
from ..room import Room
from .archive import validate
from .snapshot import dump_room, load_room
from .store import Document, IObjectStore, IStateStore

T = TypeVar("T")
LEASE_SECONDS = 15
MAX_PLAYERS = 20
MAX_STATE_BYTES = 800_000


@dataclass(frozen=True)
class Settings:
    password: str
    session_secret: str
    public_url: str
    project: str | None = None
    bucket: str = ""
    collection: str = "quiz"
    database: str = "(default)"
    secure_cookie: bool = True

    def __post_init__(self) -> None:
        if not self.password or len(self.session_secret) < 32:
            raise ValueError("主催者パスワードと32文字以上のセッション署名鍵が必要です。")
        if self.secure_cookie and not self.public_url.startswith("https://"):
            raise ValueError("公開URLには https:// が必要です。")
        from urllib.parse import urlsplit
        url = urlsplit(self.public_url)
        if url.path not in ("", "/") or url.query or url.fragment or url.username:
            raise ValueError("公開URLにはオリジンだけを指定してください。")


class TournamentService:
    def __init__(self, settings: Settings, states: IStateStore, objects: IObjectStore,
                 clock: Callable[[], float] = time.time) -> None:
        self.settings = settings
        self.states = states
        self.objects = objects
        self.clock = clock
        self.owner = secrets.token_urlsafe(24)
        self._questions: dict[str, list[Question]] = {}

    def active(self, value: Document | None) -> bool:
        return bool(value and value["status"] == "active" and value["expires_at"] > self.clock())

    def read(self) -> Document | None:
        return self.states.read("current")

    def require(self, value: Document | None, event_id: str) -> Document:
        if not self.active(value) or value["id"] != event_id:
            raise HTTPException(410, "大会は終了しています。")
        return value

    def questions(self, value: Document) -> list[Question]:
        event_id = value["id"]
        if event_id not in self._questions:
            self._questions = {event_id: validate(self.objects.get(f"{event_id}/questions.zip"))}
        return self._questions[event_id]

    def start(self, data: bytes, hours: float) -> Document:
        import math
        if not math.isfinite(hours) or not 0 < hours <= 168:
            raise HTTPException(422, "開催時間は0時間超、168時間以下で指定してください。")
        questions = validate(data)
        event_id = secrets.token_urlsafe(24)
        name = f"{event_id}/questions.zip"
        self.objects.put(name, data)
        try:
            def create(old: Document | None) -> tuple[Document, Document]:
                if self.active(old):
                    raise HTTPException(409, "既に大会を開催しています。再認証して復帰してください。")
                now = self.clock()
                value = {"id": event_id, "status": "active", "started_at": now,
                         "expires_at": now + hours * 3600, "join_key": secrets.token_urlsafe(24),
                         "version": (old or {}).get("version", 0) + 1,
                         "room": dump_room(Room(questions)), "paused": False,
                         "ai_enabled": False, "ai_context": "",
                         "owner": self.owner, "lease_until": now + LEASE_SECONDS}
                return value, value
            result = self.states.update("current", create)
        except Exception:
            # トランザクション応答喪失時に、実際には確定したデータを消さない。
            committed = self.read()
            if not committed or committed.get("id") != event_id:
                self.objects.delete(name)
            raise
        self._questions = {event_id: questions}
        return result

    def change(self, event_id: str, operation: Callable[[Room, Document], T]) -> tuple[Document, T]:
        initial = self.require(self.read(), event_id)
        questions = self.questions(initial)

        def apply(current: Document | None) -> tuple[Document, tuple[Document, T]]:
            value = copy.deepcopy(self.require(current, event_id))
            self._take_over(value)
            room = load_room(value["room"], questions)
            result = operation(room, value)
            value["room"] = dump_room(room)
            value["version"] += 1
            if len(json.dumps(value, ensure_ascii=False).encode()) > MAX_STATE_BYTES:
                raise HTTPException(413, "大会状態の保存容量を超えました。")
            return value, (value, result)

        return self.states.update("current", apply)

    def _take_over(self, value: Document) -> None:
        now = self.clock()
        if value["owner"] == self.owner:
            value["lease_until"] = now + LEASE_SECONDS
        elif value["lease_until"] <= now:
            value["owner"] = self.owner
            value["lease_until"] = now + LEASE_SECONDS
            if value["room"]["phase"] not in ("idle", "result"):
                value["paused"] = True
                # 再起動前に処理中だった AI 結果・操作を拒否する。
                value["room"]["round_id"] += 1
            for player in value["room"]["players"]:
                if not player["is_ai"]:
                    player["connected"] = False

    def heartbeat(self) -> Document | None:
        current = self.read()
        if not current or current["status"] != "active":
            return current
        event_id = current["id"]

        def update(value: Document | None) -> tuple[Document, Document]:
            value = copy.deepcopy(value)
            if value["id"] != event_id or value["status"] != "active":
                return value, value
            if value["expires_at"] <= self.clock():
                value["status"] = "ended"
                value["version"] += 1
            else:
                old_paused = value["paused"]
                old_owner = value["owner"]
                self._take_over(value)
                if old_owner != value["owner"] or old_paused != value["paused"]:
                    value["version"] += 1
            return value, value

        return self.states.update("current", update)

    def end(self, event_id: str) -> Document:
        def stop(room: Room, value: Document) -> None:
            value["status"] = "ended"
            value["ended_at"] = self.clock()
        value, _ = self.change(event_id, stop)
        # バケットのライフサイクルでも未確定データ・削除失敗を回収する。
        try:
            self.objects.delete(f"{event_id}/questions.zip")
        except Exception:
            import logging
            logging.getLogger(__name__).warning("終了済み問題データの削除を再試行してください。")
        self._questions.clear()
        return value

    def check_password(self, password: str, address: str) -> None:
        key = "auth-" + hashlib.sha256(address.encode()).hexdigest()

        def attempt(value: Document | None) -> tuple[Document, bool]:
            now = self.clock()
            if not value or value["until"] <= now:
                value = {"until": now + 300, "count": 0}
            if value["count"] >= 5:
                return value, False
            value["count"] += 1
            return value, True
        if not self.states.update(key, attempt):
            raise HTTPException(429, "認証回数の上限です。5分後に再試行してください。")
        if not secrets.compare_digest(password.encode(), self.settings.password.encode()):
            raise HTTPException(401, "パスワードが違います。")


def execute(room: Room, value: Document, message: Any, player_id: str | None, is_host: bool) -> Any:
    kind = message.type
    if kind not in ("join", "buzz", "host_hello") and not is_host:
        raise HTTPException(403, "この操作は出題者のみ行えます。")
    if kind == "host_hello":
        if not is_host:
            raise HTTPException(403, "主催者認証が必要です。")
        return None
    if kind == "join":
        if message.token and message.token not in room._tokens:
            raise HTTPException(403, "参加者トークンが無効です。再度名前を入力してください。")
        if not message.token and sum(not p.is_ai for p in room.players.values()) >= MAX_PLAYERS:
            raise HTTPException(409, "参加者は20人までです。")
        return room.join(message.name, message.token)
    if kind == "ai_toggle":
        value["ai_enabled"] = message.enabled
        if message.enabled:
            room.join_ai("AI")
        return None
    if kind == "ai_context":
        if (message.round_id == room.round_id and room.buzzed and room.buzzed.is_ai
                and room.question and room.question.text.startswith(message.read_text)):
            value["ai_context"] = message.read_text
        return None
    if kind == "resume":
        value["paused"] = False
        return None
    if value["paused"]:
        raise HTTPException(409, "復元後は主催者が再開してください。")
    if kind == "buzz":
        if player_id is None:
            raise HTTPException(403, "先に参加してください。")
        return room.buzz(player_id, message.round_id)
    if kind == "ai_join":
        return room.join_ai(message.name)
    if kind == "ai_buzz":
        ai = room.ai_player()
        if ai is None or not value.get("ai_enabled", False):
            raise HTTPException(409, "AI が参加していません。")
        return room.buzz(ai.id, message.round_id)
    if kind == "ai_answer":
        return room.set_ai_answer(message.round_id, AiAnswerView(
            answer=message.answer, reason=message.reason, models=message.models, read_text=message.read_text))
    if kind == "start_question":
        # 二重クリックや別タブによる途中の出題の上書きを防ぐ。
        if room.phase not in ("idle", "result"):
            raise HTTPException(409, "現在の問題を終了してください。")
        value["ai_context"] = ""
        if room.start_question(message.question_id) is None:
            raise HTTPException(422, "出題できる問題がありません。")
    elif kind in ("reading_ended", "time_up", "check", "release"):
        return getattr(room, kind)(message.round_id)
    elif kind == "judge":
        return room.judge(message.round_id, message.correct)
    elif kind == "next":
        if room.phase not in ("result", "timeUp"):
            raise HTTPException(409, "現在の問題を終了してください。")
        value["ai_context"] = ""
        room.next_question()
