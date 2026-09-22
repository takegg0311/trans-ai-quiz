"""AI 参加者の登録と、AI の回答の露出制御のテスト。

AI の回答は**正解より早く**（押した直後の buzzed から）投影へ出す。
正解ではないため参加者が読んでも得をせず、AI が押した時点でそのラウンドの
解答権は確定しているため（ダブルチャンスは無い）。

一方で**正解の露出は変えない**。AI の回答を早く出したことで正解まで
早く出てしまうと、投影を見ている参加者がそれを読めてしまう。
この 2 つが分かれていることを確かめるのが、このファイルの主眼である。
"""

from __future__ import annotations

import pytest

from app.protocol import AiAnswerView, AiModelAnswerView
from app.quiz import Question
from app.room import Room


def _question(seq: int = 0) -> Question:
    return Question(
        id=f"20260820/{seq}",
        batch="20260820",
        seq=seq,
        wav=None,
        txt=None,
        lab=None,
        text="日本で最も高い山は何でしょう？",
        answers=["富士山"],
    )


@pytest.fixture
def room() -> Room:
    return Room(questions=[_question(0), _question(1)])


def _answer(text: str | None = "富士山") -> AiAnswerView:
    return AiAnswerView(
        answer=text,
        reason="2/3 が同じ回答",
        models=[
            AiModelAnswerView(label="Claude", answer="富士山", elapsed_ms=1200),
            AiModelAnswerView(label="Gemini", answer="富士山", elapsed_ms=900),
            AiModelAnswerView(label="Grok", answer="", elapsed_ms=0, error="timeout"),
        ],
    )


class TestJoinAi:
    def test_ai_は参加者として登録される(self, room: Room) -> None:
        ai = room.join_ai("AI")

        assert ai.is_ai is True
        assert room.players[ai.id] is ai

    def test_二重に登録しない(self, room: Room) -> None:
        """出題者フロントを開き直すたびに AI が増えると投影の一覧が荒れる。"""
        first = room.join_ai("AI")
        second = room.join_ai("AI")

        assert first.id == second.id
        assert len([p for p in room.players.values() if p.is_ai]) == 1

    def test_人間の参加者と区別できる(self, room: Room) -> None:
        human = room.join("たろう", None)
        ai = room.join_ai("AI")

        views = {view.id: view for view in room.to_state_message(for_host=True).players}

        assert views[human.id].is_ai is False
        assert views[ai.id].is_ai is True

    def test_ai_も通常の早押し経路に乗る(self, room: Room) -> None:
        """AI 専用の分岐を作らないことの確認。

        buzz の排他・locked_out・display_names にそのまま乗る。
        """
        ai = room.join_ai("AI")
        room.start_question()

        result = room.buzz(ai.id, room.round_id)

        assert result.accepted is True
        assert room.phase == "buzzed"
        assert room.buzzed is ai

    def test_ai_が押すと他の参加者は押せない(self, room: Room) -> None:
        ai = room.join_ai("AI")
        human = room.join("たろう", None)
        room.start_question()
        room.buzz(ai.id, room.round_id)

        result = room.buzz(human.id, room.round_id)

        assert result.accepted is False
        assert result.reason == "too_late"

    def test_人間が先に押せば_ai_は押せない(self, room: Room) -> None:
        ai = room.join_ai("AI")
        human = room.join("たろう", None)
        room.start_question()
        room.buzz(human.id, room.round_id)

        result = room.buzz(ai.id, room.round_id)

        assert result.accepted is False
        assert result.reason == "too_late"


class TestSetAiAnswer:
    def test_ai_が押していれば受け取る(self, room: Room) -> None:
        ai = room.join_ai("AI")
        room.start_question()
        room.buzz(ai.id, room.round_id)

        assert room.set_ai_answer(room.round_id, _answer()) is True
        assert room.ai_answer is not None

    def test_受け取っても_phase_は変えない(self, room: Room) -> None:
        """判定は出題者が judge を押したときに行う。

        合議が固まった瞬間に判定すると、投影を見ている全員へ
        「正解はこれです。AI の回答はこれでした」と見せる間が無くなる。
        """
        ai = room.join_ai("AI")
        room.start_question()
        room.buzz(ai.id, room.round_id)

        room.set_ai_answer(room.round_id, _answer())

        assert room.phase == "buzzed"

    def test_同じラウンドで上書きできる(self, room: Room) -> None:
        """早期確定の後、残りのモデルの応答が届いたら送り直される。

        合議の結果は変えず、モデルごとの回答だけを最新にする。
        1 回だけしか受け取らないと、3 モデル目が「応答なし」のまま残る。
        """
        ai = room.join_ai("AI")
        room.start_question()
        room.buzz(ai.id, room.round_id)

        # 早期確定の時点（3 モデル目はまだ届いていない）
        first = AiAnswerView(
            answer="富士山",
            reason="2/2 が同じ回答",
            models=[
                AiModelAnswerView(label="Claude", answer="富士山", elapsed_ms=1200),
                AiModelAnswerView(label="Gemini", answer="富士山", elapsed_ms=900),
                AiModelAnswerView(label="Grok", answer="", elapsed_ms=0, error="応答なし"),
            ],
        )
        assert room.set_ai_answer(room.round_id, first) is True

        # 3 モデル目が届いた後
        second = AiAnswerView(
            answer="富士山",
            reason="2/2 が同じ回答",
            models=[
                AiModelAnswerView(label="Claude", answer="富士山", elapsed_ms=1200),
                AiModelAnswerView(label="Gemini", answer="富士山", elapsed_ms=900),
                AiModelAnswerView(label="Grok", answer="北岳", elapsed_ms=5500),
            ],
        )
        assert room.set_ai_answer(room.round_id, second) is True

        assert room.ai_answer is not None
        # 合議の結果は変わらない
        assert room.ai_answer.answer == "富士山"
        assert room.ai_answer.reason == "2/2 が同じ回答"
        # 3 モデル目の回答が反映されている
        assert room.ai_answer.models[2].answer == "北岳"
        assert room.ai_answer.models[2].error is None

    def test_人間が押したラウンドでは受け取らない(self, room: Room) -> None:
        """遅れて届いた合議結果で、投影に AI の回答が出てしまうのを防ぐ。"""
        room.join_ai("AI")
        human = room.join("たろう", None)
        room.start_question()
        room.buzz(human.id, room.round_id)

        assert room.set_ai_answer(room.round_id, _answer()) is False
        assert room.ai_answer is None

    def test_誰も押していなければ受け取らない(self, room: Room) -> None:
        room.join_ai("AI")
        room.start_question()

        assert room.set_ai_answer(room.round_id, _answer()) is False

    def test_古いラウンドの結果は受け取らない(self, room: Room) -> None:
        ai = room.join_ai("AI")
        room.start_question()
        room.buzz(ai.id, room.round_id)
        stale = room.round_id
        room.next_question()
        room.start_question()

        assert room.set_ai_answer(stale, _answer()) is False

    def test_次の問題へ進むと持ち越さない(self, room: Room) -> None:
        ai = room.join_ai("AI")
        room.start_question()
        room.buzz(ai.id, room.round_id)
        room.set_ai_answer(room.round_id, _answer())
        room.next_question()
        room.start_question()

        assert room.ai_answer is None


class TestAiAnswerVisibility:
    """AI の回答をいつ投影へ出すか。正解とは別の制御にする。"""

    def _buzzed_with_answer(self, room: Room) -> None:
        ai = room.join_ai("AI")
        room.start_question()
        room.buzz(ai.id, room.round_id)
        room.set_ai_answer(room.round_id, _answer())

    def test_buzzed_から出す(self, room: Room) -> None:
        """AI の回答は正解より早く、押した直後から出す。

        正解ではないので参加者が読んでも得をせず、AI が押した時点で
        そのラウンドの解答権は確定している（ダブルチャンスは無い）。
        """
        self._buzzed_with_answer(room)

        message = room.to_state_message(for_host=True)

        assert message.ai_answer is not None
        assert message.ai_answer.answer == "富士山"

    def test_buzzed_では正解を出さない(self, room: Room) -> None:
        """AI の回答を早く出しても、正解の露出は変えない。

        ここが崩れると、投影を見ている参加者が正解を読めてしまう。
        """
        self._buzzed_with_answer(room)

        message = room.to_state_message(for_host=True)

        assert message.question is not None
        assert message.question.answers is None

    def test_check_で正解と並ぶ(self, room: Room) -> None:
        self._buzzed_with_answer(room)
        room.check(room.round_id)

        message = room.to_state_message(for_host=True)

        assert message.ai_answer is not None
        assert message.ai_answer.answer == "富士山"
        # 正解もここで出る
        assert message.question is not None
        assert message.question.answers == ["富士山"]

    def test_result_でも出し続ける(self, room: Room) -> None:
        self._buzzed_with_answer(room)
        room.check(room.round_id)
        room.judge(room.round_id, correct=True)

        assert room.to_state_message(for_host=True).ai_answer is not None

    def test_回答者へは送らない(self, room: Room) -> None:
        """投影と同じ情報しか見せない原則。

        回答者の画面には問題文も正解も送っていない。AI の回答も同じ扱いにする。
        早く出すのは投影（出題者フロント）だけである。
        """
        self._buzzed_with_answer(room)

        assert room.to_state_message(for_host=False).ai_answer is None

        room.check(room.round_id)

        assert room.to_state_message(for_host=False).ai_answer is None

    def test_各モデルの応答も含まれる(self, room: Room) -> None:
        # 採用されなかったモデルや失敗したモデルも出す。
        # どう決まったかが分からないと合議の妥当性を確かめられない
        self._buzzed_with_answer(room)
        room.check(room.round_id)

        models = room.to_state_message(for_host=True).ai_answer
        assert models is not None
        assert [m.label for m in models.models] == ["Claude", "Gemini", "Grok"]
        assert models.models[2].error == "timeout"

    def test_全モデル失敗なら回答なしとして出す(self, room: Room) -> None:
        ai = room.join_ai("AI")
        room.start_question()
        room.buzz(ai.id, room.round_id)
        room.set_ai_answer(room.round_id, _answer(None))
        room.check(room.round_id)

        message = room.to_state_message(for_host=True)

        assert message.ai_answer is not None
        assert message.ai_answer.answer is None


class TestAiJudgement:
    def test_出題者が判定する(self, room: Room) -> None:
        """AI の回答も判定は出題者が押す。自動確定はしない。"""
        ai = room.join_ai("AI")
        room.start_question()
        room.buzz(ai.id, room.round_id)
        room.set_ai_answer(room.round_id, _answer())
        room.check(room.round_id)

        assert room.judge(room.round_id, correct=True) is True
        assert room.phase == "result"
        assert room.judgement is not None
        assert room.judgement.player_id == ai.id

    def test_ai_が誤答しても他へ権利は移らない(self, room: Room) -> None:
        """既存方針（ダブルチャンスなし）をそのまま適用する。"""
        ai = room.join_ai("AI")
        room.join("たろう", None)
        room.start_question()
        room.buzz(ai.id, room.round_id)
        room.check(room.round_id)
        room.judge(room.round_id, correct=False)

        assert room.phase == "result"
        # お手つきとして AI に locked_out が付く（人間と同じ扱い）
        assert room.players[ai.id].locked_out is True
