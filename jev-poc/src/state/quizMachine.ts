/**
 * 出題サイクルの状態遷移。
 *
 *   idle ──start──▶ jingle ──jingleEnded──▶ reading
 *                                             │
 *                        ┌────────────────────┼────────────────────┐
 *                        │                    │                    │
 *                   buzz(人間)           buzz(Jev)             audioEnded
 *                        ▼                    ▼                    ▼
 *                     buzzed             aiAnswering             timeUp
 *                        │                    │                    │
 *                     judged            aiSettled                judged
 *                        │                ┌───┴───┐                │
 *                        │             正解     誤答/全滅          │
 *                        │                │        │               │
 *                        ▼                ▼        ▼               ▼
 *                     result ◀───────────result  reading ────────result
 *                                                （再開）
 *
 * - jingle:      出題ジングル（set.WAV）の再生中
 * - reading:     問題音声の再生中。早押しを受け付ける
 * - buzzed:      人間が早押しで停止し、回答を入力している
 * - aiAnswering: Jev が早押しで停止し、LLM の回答を待っている
 * - timeUp:      早押しされないまま音声が終わった。ここからでも回答できる
 * - result:      正誤判定の結果を表示している
 *
 * **AI が誤答すると reading へ戻る。** これがこの PoC で新しい遷移である。
 * 実際の早押しクイズと同じく、誤答した側から他者へ解答権が移る。
 * 人間が誤答した場合は result へ進む（AI は押す判断を自分で行うため、
 * 権利を渡す先として扱えない）。
 */
import type { Consensus } from '../lib/consensus';
import type { Question } from '../lib/manifest';

export type Phase =
  | 'loading'
  | 'idle'
  | 'jingle'
  | 'reading'
  | 'buzzed'
  | 'aiAnswering'
  | 'timeUp'
  | 'result';

/** 誰が回答したか。結果表示で勝敗を示すために使う */
export type Answerer = 'human' | 'ai';

export type Judgement = {
  input: string;
  correct: boolean;
  by: Answerer;
};

export type QuizState = {
  phase: Phase;
  question: Question | null;
  /** 早押し・音声終了で確定した表示文字数。null なら再生位置に追従する */
  frozenLength: number | null;
  /**
   * 自動早押しで、Jev が押すと判断した時点の文字数。手動の場合は null。
   *
   * 表示（frozenLength）とは別に持つ。判定から押下までの間にも読み上げは
   * 進むため、表示を判定位置まで戻すと読まれた文字が消えて見える。
   * 表示は読み進んだところまでを残し、判定位置はここで示す。
   */
  judgedLength: number | null;
  judgement: Judgement | null;
  /** AI が答えた結果。誤答で reading へ戻った後も画面に残す */
  aiAttempt: { answer: string | null; consensus: Consensus } | null;
  error: string | null;
};

export type QuizAction =
  | { type: 'loadFailed'; message: string }
  | { type: 'ready' }
  /** 次の問題が用意できた。ジングル再生へ入る */
  | { type: 'questionLoaded'; question: Question }
  | { type: 'jingleEnded' }
  /** 人間が早押しした。その時点の表示文字数で問題文を止める */
  | { type: 'buzz'; visibleLength: number }
  /** Jev が早押しした。LLM の回答待ちへ入る */
  | { type: 'aiBuzz'; visibleLength: number; judgedLength: number }
  /**
   * AI の回答が出そろった。正解なら result、誤答・全滅なら reading へ戻す。
   * 戻す判断は呼び出し側が行う（正誤判定は正解を持つ側の責務のため）。
   */
  | { type: 'aiSettled'; answer: string | null; consensus: Consensus; correct: boolean }
  /** 早押しされないまま音声が終わった */
  | { type: 'audioEnded'; visibleLength: number }
  | { type: 'judged'; judgement: Judgement }
  | { type: 'next' };

export const initialState: QuizState = {
  phase: 'loading',
  question: null,
  frozenLength: null,
  judgedLength: null,
  judgement: null,
  aiAttempt: null,
  error: null,
};

export function quizReducer(state: QuizState, action: QuizAction): QuizState {
  switch (action.type) {
    case 'loadFailed':
      return { ...state, phase: 'idle', error: action.message };

    case 'ready':
      return { ...state, phase: 'idle', error: null };

    case 'questionLoaded':
      return {
        ...state,
        phase: 'jingle',
        question: action.question,
        frozenLength: null,
        judgedLength: null,
        judgement: null,
        aiAttempt: null,
        error: null,
      };

    case 'jingleEnded':
      // ジングルの再生完了を待ってから問題音声を始める
      return state.phase === 'jingle' ? { ...state, phase: 'reading' } : state;

    case 'buzz':
      return state.phase === 'reading'
        ? {
            ...state,
            phase: 'buzzed',
            frozenLength: action.visibleLength,
            judgedLength: null,
          }
        : state;

    case 'aiBuzz':
      return state.phase === 'reading'
        ? {
            ...state,
            phase: 'aiAnswering',
            frozenLength: action.visibleLength,
            judgedLength: action.judgedLength,
          }
        : state;

    case 'aiSettled': {
      if (state.phase !== 'aiAnswering') return state;

      const aiAttempt = { answer: action.answer, consensus: action.consensus };

      // 正解なら AI の勝ちとして結果表示へ
      if (action.correct && action.answer !== null) {
        return {
          ...state,
          phase: 'result',
          aiAttempt,
          judgement: { input: action.answer, correct: true, by: 'ai' },
        };
      }

      // 誤答・全滅なら読み上げを再開し、人間へ解答権が移る。
      // frozenLength を null へ戻して再生位置への追従を再開させる。
      // judgedLength も消す。灰色表示は「AI が見ていた範囲」を示すもので、
      // 権利が人間へ移った後は意味を持たない。
      return {
        ...state,
        phase: 'reading',
        frozenLength: null,
        judgedLength: null,
        aiAttempt,
      };
    }

    case 'audioEnded':
      return state.phase === 'reading'
        ? { ...state, phase: 'timeUp', frozenLength: action.visibleLength }
        : state;

    case 'judged':
      return state.phase === 'buzzed' || state.phase === 'timeUp'
        ? { ...state, phase: 'result', judgement: action.judgement }
        : state;

    case 'next':
      return { ...state, phase: 'idle', judgement: null, aiAttempt: null, error: null };

    default:
      return state;
  }
}

/** 早押しを受け付けてよいか */
export function canBuzz(phase: Phase): boolean {
  return phase === 'reading';
}

/** 人間が回答を入力できるか */
export function canAnswer(phase: Phase): boolean {
  return phase === 'buzzed' || phase === 'timeUp';
}
