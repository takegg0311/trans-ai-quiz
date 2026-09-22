"""WebSocket のメッセージ定義。

全メッセージは {"type": "..."} を持ち、type で判別する（discriminated union）。
この定義が web/src/protocol.ts と対になる。

方針: 状態は差分イベントではなく room_state を丸ごと送る。
再接続が「繋いで最新の room_state を受け取るだけ」で復元でき、
復元用のコードを別途書かずに済む。参加者は十数人・状態は小さいので
帯域は問題にならない。

例外は buzz_accepted で、これだけは音声停止のレイテンシに直結するため
room_state の組み立てを待たず最小ペイロードで先に送る。
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------- 共通

Phase = Literal["idle", "reading", "readingEnded", "buzzed", "check", "timeUp", "result"]

# 早押しを受け付けなかった理由
BuzzRejectReason = Literal["too_late", "stale_round", "locked_out", "wrong_phase"]


class PlayerView(BaseModel):
    """参加者 1 人の公開情報。"""

    id: str
    name: str
    # 切断しても一覧からは消さない。投影画面から名前が消えると出題者が混乱する。
    connected: bool
    # お手つきで同一ラウンドの早押しを禁じられている
    locked_out: bool
    # AI（Jev + LLM 合議）の参加者か。投影で人間と区別するために使う。
    # 早押しの扱いは人間と同じで、buzz の排他も locked_out もそのまま乗る。
    is_ai: bool = False


class BuzzedView(BaseModel):
    """回答権を得た参加者。"""

    player_id: str
    name: str


class AiModelAnswerView(BaseModel):
    """合議に参加した 1 モデルの応答。"""

    label: str
    #: 回答。失敗した場合は空
    answer: str = ""
    #: サーバ実測の応答時間
    elapsed_ms: int = 0
    #: 失敗した場合の理由。成功時は None
    error: str | None = None


class AiAnswerView(BaseModel):
    """AI の回答。正解と同じ phase でのみ投影へ出す。

    合議が固まった時点ではなく、出題者が check を押して正解が出るのと
    同じタイミングで見せる。投影を全員で見ながら進行するため、
    「正解はこれです。AI の回答はこれでした」と見せる間が要る。
    """

    #: 合議で採用された回答。全モデルが失敗した場合は None
    answer: str | None = None
    #: どう決まったか（多数決 / 最速採用 / 回答なし）の説明
    reason: str = ""
    #: 各モデルの応答。採用されなかったものも含めて出す
    models: list[AiModelAnswerView] = Field(default_factory=list)


class QuestionView(BaseModel):
    """出題内容。回答者には送らない（問題文を先に見せないため）。"""

    id: str
    text: str
    # 音声なし問題では None。フロントは読み上げを鳴らさず、
    # char_interval_ms の間隔で 1 文字ずつ問題文を送る。
    audio_url: str | None = None
    lab_url: str | None = None
    # 音声なし問題の文字送り間隔（ミリ秒/文字）。
    # 音声あり問題では .lab に従うため使わない。
    # サーバが持つのは、出題者フロントを開き直しても設定が変わらないようにするため。
    char_interval_ms: int
    # 正解と別解。投影は参加者も見るため、正解を出してよい phase
    # （check / timeUp / result）でのみ値が入る。それ以外は None。
    answers: list[str] | None = None


class JudgementView(BaseModel):
    """正誤判定の結果。"""

    player_id: str
    name: str
    correct: bool


# ---------------------------------------------------- クライアント → サーバ


class JoinMessage(BaseModel):
    type: Literal["join"] = "join"
    name: str
    # 再接続時に前回の player_id へ再バインドするための token
    token: str | None = None


class HostHelloMessage(BaseModel):
    type: Literal["host_hello"] = "host_hello"
    host_token: str


class BuzzMessage(BaseModel):
    type: Literal["buzz"] = "buzz"
    round_id: int
    # 端末時計はズレるため判定には使わない。ログ・後日分析用。
    client_sent_at: int | None = None


class AiJoinMessage(BaseModel):
    """AI を参加者として登録する。出題者フロントが送る。

    AI 専用の参加経路を作らず、通常の Player として登録する。buzz の排他
    （単一イベントループを利用し await を挟まない）、locked_out、
    display_names の重複処理、投影の参加者一覧——これらにそのまま乗る。
    """

    type: Literal["ai_join"] = "ai_join"
    name: str = "AI"


class AiBuzzMessage(BaseModel):
    """AI が早押しする。出題者フロントが送る。

    buzz と分けているのは、buzz が「その接続自身の player_id」で押す
    メッセージであるため。出題者接続は player_id を持たず、かといって
    buzz に player_id を載せられるようにすると、出題者が任意の参加者に
    なりすまして押せてしまう。AI を押す専用の経路として分ける。

    判定そのものは Room.buzz に委ね、排他も locked_out も人間と同じ扱いにする。
    """

    type: Literal["ai_buzz"] = "ai_buzz"
    round_id: int
    #: Jev が押すと判断した時点の文字数。記録と表示に使う
    judged_length: int | None = None


class AiAnswerMessage(BaseModel):
    """AI の合議結果を送る。出題者フロントが送る。

    合議そのものは出題者フロントで行う。サーバは文字位置を持たず、
    Jev の判定も LLM の呼び出しもフロント側にあるため、結果だけを預かる。

    受け取っても phase は変えない。判定は出題者が judge を押したときに行う。
    """

    type: Literal["ai_answer"] = "ai_answer"
    round_id: int
    answer: str | None = None
    reason: str = ""
    models: list[AiModelAnswerView] = Field(default_factory=list)


class StartQuestionMessage(BaseModel):
    type: Literal["start_question"] = "start_question"
    # 省略時はサーバが抽選する
    question_id: str | None = None


class ReadingEndedMessage(BaseModel):
    """問題音声を最後まで再生し終えた。出題者フロントが自動で送る。

    読み切っても早押しは受け付け続ける（readingEnded）。
    締め切るのは出題者が time_up を押したとき。
    """

    type: Literal["reading_ended"] = "reading_ended"
    round_id: int


class TimeUpMessage(BaseModel):
    """出題者が回答の受付を締め切る。ここで正解を投影に出す。"""

    type: Literal["time_up"] = "time_up"
    round_id: int


class CheckMessage(BaseModel):
    """回答を聞き終えたので正解を確認する。ここで初めて正解を投影に出す。

    buzzed のうちは正解を出さない。投影は参加者も見るため、
    回答権を得た時点で正解が見えると、それを読んで答えられてしまう。
    """

    type: Literal["check"] = "check"
    round_id: int


class JudgeMessage(BaseModel):
    type: Literal["judge"] = "judge"
    round_id: int
    correct: bool


class ReleaseMessage(BaseModel):
    """お手つき解除。誤答者を弾いたまま同じ問題を再開する。"""

    type: Literal["release"] = "release"
    round_id: int


class NextMessage(BaseModel):
    type: Literal["next"] = "next"


ClientMessage = Annotated[
    JoinMessage
    | HostHelloMessage
    | BuzzMessage
    | AiJoinMessage
    | AiBuzzMessage
    | AiAnswerMessage
    | StartQuestionMessage
    | ReadingEndedMessage
    | TimeUpMessage
    | CheckMessage
    | JudgeMessage
    | ReleaseMessage
    | NextMessage,
    Field(discriminator="type"),
]


# ---------------------------------------------------- サーバ → クライアント


class WelcomeMessage(BaseModel):
    type: Literal["welcome"] = "welcome"
    player_id: str
    # localStorage に保存し、次回の join に載せてもらう
    token: str
    role: Literal["player", "host"]


class RoomStateMessage(BaseModel):
    type: Literal["room_state"] = "room_state"
    round_id: int
    phase: Phase
    players: list[PlayerView]
    buzzed: BuzzedView | None = None
    # 回答者へは None にして送る
    question: QuestionView | None = None
    judgement: JudgementView | None = None
    # AI の回答。正解と同じ phase でのみ載せる（ANSWER_VISIBLE_PHASES）。
    # 早い phase で載せると、投影を見ている参加者が AI の答えを読んで
    # そのまま答えられてしまう。
    ai_answer: AiAnswerView | None = None
    # この一巡で未出題の問題数と全問数。出題者が残りを把握するために使う。
    # 正解の手がかりにはならないので回答者にも送るが、表示するのは出題者画面だけ。
    remaining_questions: int = 0
    total_questions: int = 0


class BuzzAcceptedMessage(BaseModel):
    """最初の 1 人が確定した。音声停止のレイテンシに直結するので最小構成。"""

    type: Literal["buzz_accepted"] = "buzz_accepted"
    round_id: int
    player_id: str
    name: str


class BuzzRejectedMessage(BaseModel):
    type: Literal["buzz_rejected"] = "buzz_rejected"
    round_id: int
    reason: BuzzRejectReason


class ErrorMessage(BaseModel):
    type: Literal["error"] = "error"
    code: str
    message: str


ServerMessage = (
    WelcomeMessage
    | RoomStateMessage
    | BuzzAcceptedMessage
    | BuzzRejectedMessage
    | ErrorMessage
)
