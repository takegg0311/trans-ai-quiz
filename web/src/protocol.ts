/**
 * WebSocket のメッセージ型。server/app/protocol.py と対になる。
 * 片方を変えたらもう片方も変えること。
 */

export type Phase =
  | 'idle'
  /** 問題音声を再生中。早押しを受け付ける */
  | 'reading'
  /** 読み切ったが、まだ締め切っていない。早押しを受け付ける */
  | 'readingEnded'
  /** 誰かが回答権を得た。正解はまだ出さない */
  | 'buzzed'
  /** 正解を確認して正誤を判定する。ここで正解が投影に出る */
  | 'check'
  /** 誰も押さずに締め切った */
  | 'timeUp'
  | 'result';

export type BuzzRejectReason =
  | 'too_late'
  | 'stale_round'
  | 'locked_out'
  | 'wrong_phase';

export type PlayerView = {
  id: string;
  name: string;
  /** 切断しても一覧からは消さない。投影画面から名前が消えると混乱するため */
  connected: boolean;
  /** お手つきで同一ラウンドの早押しを禁じられている */
  locked_out: boolean;
  /**
   * AI（Jev + LLM 合議）の参加者か。投影で人間と区別するために使う。
   * 早押しの扱いは人間と同じで、buzz の排他も locked_out もそのまま乗る。
   */
  is_ai: boolean;
};

/** 合議に参加した 1 モデルの応答 */
export type AiModelAnswerView = {
  label: string;
  /** 回答。失敗した場合は空 */
  answer: string;
  /** サーバ実測の応答時間 */
  elapsed_ms: number;
  /** 失敗した場合の理由。成功時は null */
  error?: string | null;
};

/**
 * AI の回答。正解と同じ phase でのみ投影へ出る。
 *
 * 合議が固まった時点ではなく、出題者が check を押して正解が出るのと
 * 同じタイミングで見せる。
 */
export type AiAnswerView = {
  /** 合議で採用された回答。全モデルが失敗した場合は null */
  answer: string | null;
  /** どう決まったかの説明 */
  reason: string;
  /** 各モデルの応答。採用されなかったものも含む */
  models: AiModelAnswerView[];
};

export type BuzzedView = {
  player_id: string;
  name: string;
};

/** 出題内容。回答者へは null で送られる */
export type QuestionView = {
  id: string;
  text: string;
  /**
   * 音声なし問題では null。読み上げを鳴らさず、char_interval_ms の
   * 間隔で 1 文字ずつ問題文を送る。
   */
  audio_url: string | null;
  lab_url: string | null;
  /** 音声なし問題の文字送り間隔（ミリ秒/文字） */
  char_interval_ms: number;
  /**
   * 正解と別解。投影は参加者も見るため、正解を出してよい phase
   * （check / timeUp / result）でのみ値が入る。それ以外は null。
   */
  answers: string[] | null;
};

export type JudgementView = {
  player_id: string;
  name: string;
  correct: boolean;
};

// ---------------------------------------------------- クライアント → サーバ

export type ClientMessage =
  | { type: 'join'; name: string; token?: string | null }
  | { type: 'host_hello'; host_token: string }
  | { type: 'buzz'; round_id: number; client_sent_at?: number }
  /** AI を参加者として登録する。出題者のみ */
  | { type: 'ai_join'; name?: string }
  /**
   * AI が早押しする。出題者のみ。
   *
   * buzz と分けているのは、buzz が「その接続自身の player_id」で押す
   * メッセージであるため。buzz へ player_id を載せられるようにすると、
   * 出題者が任意の参加者になりすまして押せてしまう。
   */
  | { type: 'ai_buzz'; round_id: number; judged_length?: number | null }
  /** AI の合議結果を送る。出題者のみ。受け取っても phase は変わらない */
  | {
      type: 'ai_answer';
      round_id: number;
      answer: string | null;
      reason: string;
      models: AiModelAnswerView[];
    }
  | { type: 'start_question'; question_id?: string | null }
  | { type: 'reading_ended'; round_id: number }
  | { type: 'time_up'; round_id: number }
  | { type: 'check'; round_id: number }
  | { type: 'judge'; round_id: number; correct: boolean }
  | { type: 'release'; round_id: number }
  | { type: 'next' };

// ---------------------------------------------------- サーバ → クライアント

export type WelcomeMessage = {
  type: 'welcome';
  player_id: string;
  token: string;
  role: 'player' | 'host';
};

export type RoomStateMessage = {
  type: 'room_state';
  round_id: number;
  phase: Phase;
  players: PlayerView[];
  buzzed: BuzzedView | null;
  question: QuestionView | null;
  judgement: JudgementView | null;
  /**
   * AI の回答。正解と同じ phase でのみ載る（check / timeUp / result）。
   * 回答者へは常に null で送られる。
   */
  ai_answer: AiAnswerView | null;
  /** この一巡で未出題の問題数 */
  remaining_questions: number;
  /** 全問数 */
  total_questions: number;
};

export type BuzzAcceptedMessage = {
  type: 'buzz_accepted';
  round_id: number;
  player_id: string;
  name: string;
};

export type BuzzRejectedMessage = {
  type: 'buzz_rejected';
  round_id: number;
  reason: BuzzRejectReason;
};

export type ErrorMessage = {
  type: 'error';
  code: string;
  message: string;
};

export type ServerMessage =
  | WelcomeMessage
  | RoomStateMessage
  | BuzzAcceptedMessage
  | BuzzRejectedMessage
  | ErrorMessage;

/** 押せなかった理由を、回答者に見せる文言にする */
export function describeRejectReason(reason: BuzzRejectReason): string {
  switch (reason) {
    case 'too_late':
      return '他の人が先に押しました';
    case 'locked_out':
      return 'この問題では、もう押せません';
    case 'stale_round':
    case 'wrong_phase':
      return '今は押せません';
  }
}
