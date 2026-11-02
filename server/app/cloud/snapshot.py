"""Room の非公開スナップショット。出題データ本体は含めない。"""
from __future__ import annotations

from dataclasses import asdict
from typing import Any

from ..protocol import AiAnswerView, JudgementView
from ..quiz import Question
from ..room import Player, Room


def dump_room(room: Room) -> dict[str, Any]:
    return {
        "phase": room.phase, "round_id": room.round_id,
        "question": room.question.id if room.question else None,
        "buzzed": room.buzzed.id if room.buzzed else None,
        "judgement": room.judgement.model_dump() if room.judgement else None,
        "ai_answer": room.ai_answer.model_dump() if room.ai_answer else None,
        "players": [asdict(player) for player in room.players.values()],
        "next_player_number": room._next_player_number,
        "deck": [question.id for question in room._shuffler._deck],
        "last_id": room._shuffler._last_id,
    }


def load_room(value: dict[str, Any], questions: list[Question]) -> Room:
    room = Room(questions)
    by_id = {question.id: question for question in questions}
    room.phase = value["phase"]
    room.round_id = value["round_id"]
    room.question = by_id.get(value["question"])
    room.players = {item["id"]: Player(**item) for item in value["players"]}
    room._tokens = {player.token: player.id for player in room.players.values()}
    room._next_player_number = value["next_player_number"]
    room.buzzed = room.players.get(value["buzzed"])
    room.judgement = JudgementView(**value["judgement"]) if value["judgement"] else None
    room.ai_answer = AiAnswerView(**value["ai_answer"]) if value["ai_answer"] else None
    room._shuffler._deck = [by_id[key] for key in value["deck"]]
    room._shuffler._last_id = value["last_id"]
    return room
