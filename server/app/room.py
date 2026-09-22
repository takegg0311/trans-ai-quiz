"""ルームの状態機械。早押し判定の本体。

    idle ──start_question──▶ reading ──audio終了──▶ readingEnded ──time_up──▶ timeUp
                                │ buzz                  │ buzz                   │
                                ▼    ┌──────────────────┘                        │
                             buzzed ─┤                                           │
                                │    └─release（押し間違いの取り消し）─▶ reading │
                              check                                              │
                                ▼                                                ▼
                             check ──judge──▶ result ◀───────── judge ───────────┘
                                                 │
                                               next ──▶ idle

早押しを受け付けるのは reading と readingEnded。音声を読み切っても
締め切らないのは、読み切ってから数秒は押させるのが通例のため。
締め切るのは出題者が time_up を押したときだけ。

正解を投影に出してよいのは check / timeUp / result だけ。投影は参加者も
見るので、buzzed の時点で正解が出ていると、それを読んで答えられてしまう。

サーバの phase は「早押しを受け付けてよいか」「正解を出してよいか」を
決めるためだけに存在する。
PoC の loading / jingle に当たるものは持たない。前者はクライアント都合、
後者は出題者フロントのローカル演出であり、混ぜると排他ロジックが読めなくなる。

このモジュールは同期メソッドだけで構成し、送信（await）は呼び出し側で行う。
理由は buzz() のコメントを参照。
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from .protocol import (
    AiAnswerView,
    BuzzedView,
    BuzzRejectReason,
    JudgementView,
    Phase,
    PlayerView,
    QuestionView,
    RoomStateMessage,
)
from .quiz import Question, QuestionShuffler, char_interval_ms

# 投影画面のレイアウトが崩れない範囲に切る
MAX_NAME_LENGTH = 12

# 正解を投影に出してよい phase。投影は参加者も見るため、
# それ以外では出題者フロントにも正解を送らない。
ANSWER_VISIBLE_PHASES: frozenset[str] = frozenset({"check", "timeUp", "result"})

# AI の回答を投影に出してよい phase。正解より早く、押した直後から出す。
#
# 正解と違って早く出しても不利益が無い。AI の回答は「AI が何と答えたか」で
# あって正解ではなく、しかも AI が押した時点でそのラウンドの解答権は
# 確定している（judge のとおりダブルチャンスは無い）。他の参加者が
# それを読んで得をする余地が無いため、チェック前に見せてよい。
#
# 早く出すことで、出題者と参加者が「AI が何と答えたか」を見ながら
# 正解チェックへ進める。
AI_ANSWER_VISIBLE_PHASES: frozenset[str] = frozenset(
    {"buzzed", "check", "timeUp", "result"}
)


@dataclass
class Player:
    id: str
    name: str
    # 再接続時に同じ player_id へ再バインドするための秘密
    token: str
    connected: bool = True
    # お手つき。同一ラウンドの間だけ早押しを禁じる
    locked_out: bool = False
    # AI（Jev + LLM 合議）の参加者か。
    # 早押しの扱いは人間と同じで、buzz の排他も locked_out もそのまま乗る。
    # 区別するのは投影の表示と、AI の回答を紐付けるためだけ。
    is_ai: bool = False

    def to_view(self) -> PlayerView:
        return PlayerView(
            id=self.id,
            name=self.name,
            connected=self.connected,
            locked_out=self.locked_out,
            is_ai=self.is_ai,
        )


@dataclass
class BuzzResult:
    """buzz() の結果。accepted が False なら reason が入る。"""

    accepted: bool
    player: Player | None = None
    reason: BuzzRejectReason | None = None


@dataclass
class Room:
    questions: list[Question]

    phase: Phase = "idle"
    # start_question のたびに +1 する。古い buzz を弾くために使う
    round_id: int = 0
    question: Question | None = None
    buzzed: Player | None = None
    judgement: JudgementView | None = None
    # AI の合議結果。出題者フロントが ai_answer で送ってくる。
    # 受け取っても phase は変えない（判定は出題者が judge を押したとき）。
    ai_answer: AiAnswerView | None = None

    players: dict[str, Player] = field(default_factory=dict)
    # token -> player_id。再接続の名寄せに使う
    _tokens: dict[str, str] = field(default_factory=dict)
    _next_player_number: int = 1
    # 出題の抽選器。全問を 1 つの山として持ち、一巡するまで再出題しない。
    # 直前の問題の記憶もこの中にある
    _shuffler: QuestionShuffler = field(init=False)

    def __post_init__(self) -> None:
        self._shuffler = QuestionShuffler(self.questions)

    # ------------------------------------------------------------ 参加者

    def join(self, name: str, token: str | None) -> Player:
        """参加または再接続する。

        token が既知なら同じ player_id へ再バインドし、名前だけ更新する。
        リロードで別人になってしまうのを防ぐ。
        """
        trimmed = name.strip()[:MAX_NAME_LENGTH] or "名無し"

        if token is not None:
            player_id = self._tokens.get(token)
            if player_id is not None and player_id in self.players:
                player = self.players[player_id]
                player.name = trimmed
                player.connected = True
                return player

        player = Player(
            id=f"p_{self._next_player_number}",
            name=trimmed,
            token=secrets.token_urlsafe(24),
        )
        self._next_player_number += 1
        self.players[player.id] = player
        self._tokens[player.token] = player.id
        return player

    def join_ai(self, name: str) -> Player:
        """AI を参加者として登録する。既に居ればそれを返す。

        AI 専用の分岐を作らず通常の Player として持つ。buzz の排他・
        locked_out・display_names・投影の一覧にそのまま乗せるため。

        出題者フロントを開き直すたびに増えないよう、既存の AI を使い回す。
        """
        for player in self.players.values():
            if player.is_ai:
                player.connected = True
                return player

        trimmed = name.strip()[:MAX_NAME_LENGTH] or "AI"
        player = Player(
            id=f"p_{self._next_player_number}",
            name=trimmed,
            token=secrets.token_urlsafe(24),
            is_ai=True,
        )
        self._next_player_number += 1
        self.players[player.id] = player
        self._tokens[player.token] = player.id
        return player

    def ai_player(self) -> Player | None:
        """登録済みの AI を返す。居なければ None。"""
        for player in self.players.values():
            if player.is_ai:
                return player
        return None

    def set_ai_answer(self, round_id: int, answer: AiAnswerView) -> bool:
        """AI の合議結果を預かる。

        **phase は変えない。** 判定は出題者が judge を押したときに行う。
        合議が固まった瞬間に判定すると、投影を見ている全員に
        「正解はこれです。AI の回答はこれでした」と見せる間が無くなる。

        AI が押していないラウンドでは受け取らない。人間が押した後に
        遅れて届いた合議結果で、投影に AI の回答が出てしまうため。
        """
        if round_id != self.round_id:
            return False
        if self.buzzed is None or not self.buzzed.is_ai:
            return False

        self.ai_answer = answer
        return True

    def disconnect(self, player_id: str) -> None:
        """切断を記録する。一覧からは消さない。

        投影画面から名前が消えると出題者が混乱するため。
        buzzed 中に切断しても phase は変えない。会場にその人は居るので
        出題者が手動で判定できる。
        """
        player = self.players.get(player_id)
        if player is not None:
            player.connected = False

    def display_names(self) -> dict[str, str]:
        """投影用の表示名。同名が複数居るときだけ連番を付ける。"""
        counts: dict[str, int] = {}
        for player in self.players.values():
            counts[player.name] = counts.get(player.name, 0) + 1

        seen: dict[str, int] = {}
        names: dict[str, str] = {}
        for player in self.players.values():
            if counts[player.name] == 1:
                names[player.id] = player.name
                continue
            seen[player.name] = seen.get(player.name, 0) + 1
            names[player.id] = f"{player.name} ({seen[player.name]})"
        return names

    # ------------------------------------------------------------ 出題

    def start_question(self, question_id: str | None = None) -> Question | None:
        """出題を始める。ジングルの完了は待たない。

        ジングル中の buzz はサーバが受け付け、出題者フロントがジングルを止めて
        その人を表示すればよい。フライングは会場の判断で処理できる。
        「ジングル完了を待って reading にする」設計は往復が挟まる分だけ
        受付開始の境界が曖昧になる。
        """
        question = self._shuffler.take(question_id)

        if question is None:
            return None

        self.round_id += 1
        self.phase = "reading"
        self.question = question
        self.buzzed = None
        self.judgement = None
        # 前問の AI の回答を持ち越さない
        self.ai_answer = None

        # ラウンドが変わればお手つきは解除する
        for player in self.players.values():
            player.locked_out = False

        return question

    def buzz(self, player_id: str, round_id: int) -> BuzzResult:
        """早押しを受け付ける。最初の 1 人だけが通る。

        排他について:
        FastAPI/uvicorn の WebSocket ハンドラは単一の asyncio イベントループ上の
        コルーチンで、await の切れ目でしか他へ切り替わらない。したがって
        検証から self.buzzed への代入までを await を挟まずに実行すれば、
        2 人が同時に押しても割り込まれず、asyncio.Lock は要らない。

        !!! このメソッドの中に await を入れてはならない !!!
        入れた瞬間、2 人目が「まだ buzzed が None」の状態で通過しうる。
        送信は呼び出し側で行うこと。

        判定は「サーバがメッセージを受け取った順」であり、クライアントが申告した
        時刻は使わない。端末時計のズレを補正するには NTP 相当の同期が要り、
        「ネットワークによる判定ラグは許容」という前提と釣り合わないため。
        """
        # --- ここから await 禁止 ---
        if round_id != self.round_id:
            return BuzzResult(accepted=False, reason="stale_round")

        # 押し負けたことは wrong_phase ではなく too_late として返す。
        # 1 人目の buzz で phase は buzzed に変わっているため、phase を先に
        # 見ると 2 人目まで wrong_phase になり、回答者の画面に出す文言も
        # 「今は押せない」と「もう押された」で取り違えてしまう。
        if self.buzzed is not None:
            return BuzzResult(accepted=False, reason="too_late")

        # 読み切った後（readingEnded）も受け付ける。締め切りは time_up。
        if self.phase not in ("reading", "readingEnded"):
            return BuzzResult(accepted=False, reason="wrong_phase")

        player = self.players.get(player_id)
        if player is None:
            return BuzzResult(accepted=False, reason="wrong_phase")

        if player.locked_out:
            return BuzzResult(accepted=False, reason="locked_out")

        self.buzzed = player
        self.phase = "buzzed"
        # --- ここまで await 禁止 ---

        return BuzzResult(accepted=True, player=player)

    def reading_ended(self, round_id: int) -> bool:
        """問題音声を読み切った。まだ早押しは受け付ける。

        締め切るのは出題者が time_up を押したとき。読み切ってすぐ締め切ると、
        考えてから押す間が無くなる。
        """
        if round_id != self.round_id or self.phase != "reading":
            return False
        self.phase = "readingEnded"
        return True

    def time_up(self, round_id: int) -> bool:
        """出題者が回答の受付を締め切る。誰も押さなかったのでスルー。"""
        if round_id != self.round_id or self.phase != "readingEnded":
            return False
        self.phase = "timeUp"
        return True

    def check(self, round_id: int) -> bool:
        """回答を聞き終えたので正解を確認する。ここで正解が投影に出る。"""
        if round_id != self.round_id or self.phase != "buzzed":
            return False
        self.phase = "check"
        return True

    def judge(self, round_id: int, correct: bool) -> bool:
        """出題者が正誤を判定する。正解を確認した後（check）に押す。

        誤答でもその問題は終わり、result へ進む。同じ問題で 2 人目の buzz を
        受け付ける運用（ダブルチャンス）は行わない方針。
        """
        if round_id != self.round_id or self.phase not in ("check", "timeUp"):
            return False

        if self.buzzed is not None:
            self.judgement = JudgementView(
                player_id=self.buzzed.id,
                name=self.buzzed.name,
                correct=correct,
            )
            if not correct:
                self.buzzed.locked_out = True
        else:
            # 押されずに読み切った場合。判定対象の回答者が居ない
            self.judgement = None

        self.phase = "result"
        return True

    def release(self, round_id: int) -> bool:
        """回答権を取り消して問題を続ける。

        誤って押してしまった事故の逃げ口として buzzed からのみ使う。
        判定を経ないので locked_out にはしない。
        """
        if round_id != self.round_id or self.phase != "buzzed":
            return False
        if self.question is None:
            return False

        self.buzzed = None
        self.judgement = None
        self.phase = "reading"
        return True

    def next_question(self) -> None:
        """出題待ちへ戻す。"""
        self.phase = "idle"
        self.question = None
        self.buzzed = None
        self.judgement = None
        for player in self.players.values():
            player.locked_out = False

    # ------------------------------------------------------------ 配信

    def to_state_message(self, *, for_host: bool) -> RoomStateMessage:
        """現在の状態を組み立てる。

        問題文と正解は出題者にだけ送る。回答者の画面に問題文が出てしまうと
        音声より先に読めてしまい、早押しの意味が無くなる。
        """
        names = self.display_names()

        question_view: QuestionView | None = None
        if for_host and self.question is not None:
            question_view = QuestionView(
                id=self.question.id,
                text=self.question.text,
                # 音声なし問題では None になる。フロントは等速の文字送りへ切り替える
                audio_url=self.question.audio_url(),
                lab_url=self.question.lab_url(),
                char_interval_ms=char_interval_ms(),
                # 正解は投影に出してよい phase でのみ載せる。
                # 出題者フロントに渡した時点で投影に映りうるので、
                # 表示するかどうかの判断をフロントに委ねず、ここで落とす。
                answers=(
                    self.question.answers
                    if self.phase in ANSWER_VISIBLE_PHASES
                    else None
                ),
            )

        buzzed_view: BuzzedView | None = None
        if self.buzzed is not None:
            buzzed_view = BuzzedView(
                player_id=self.buzzed.id,
                name=names.get(self.buzzed.id, self.buzzed.name),
            )

        return RoomStateMessage(
            round_id=self.round_id,
            phase=self.phase,
            players=[
                PlayerView(
                    id=player.id,
                    name=names.get(player.id, player.name),
                    connected=player.connected,
                    locked_out=player.locked_out,
                    is_ai=player.is_ai,
                )
                for player in self.players.values()
            ],
            buzzed=buzzed_view,
            question=question_view,
            judgement=self.judgement,
            # 正解と同じ phase でのみ出す。早い phase で載せると、投影を
            # 見ている参加者が AI の答えを読んでそのまま答えられてしまう。
            # 回答者にも送らない（投影と同じ情報しか見せない原則）。
            # AI の回答は正解より早く出す（buzzed から）。正解ではないため
            # 参加者が読んでも得をせず、解答権も既に確定している。
            ai_answer=(
                self.ai_answer
                if for_host and self.phase in AI_ANSWER_VISIBLE_PHASES
                else None
            ),
            remaining_questions=self._shuffler.remaining,
            total_questions=self._shuffler.total,
        )
