/**
 * 出題サイクルの状態遷移。
 *
 *   idle ──start──▶ jingle ──jingleEnded──▶ reading ──buzz──▶ buzzed
 *                                              │                  │
 *                                          audioEnded          judge
 *                                              ▼                  ▼
 *                                          timeUp ─────────▶  result ──next──▶ jingle
 *
 * - jingle:  出題ジングル（set.WAV）の再生中
 * - reading: 問題音声の再生中。早押しを受け付ける
 * - buzzed:  早押しで停止し、回答を入力している
 * - timeUp:  早押しされないまま音声が終わった。ここからでも回答できる
 * - result:  正誤判定の結果を表示している
 */
import type { Question } from '../lib/manifest';

export type Phase = 'loading' | 'idle' | 'jingle' | 'reading' | 'buzzed' | 'timeUp' | 'result';

export type Judgement = {
  input: string;
  correct: boolean;
};

export type QuizState = {
  phase: Phase;
  question: Question | null;
  /** 早押し・音声終了で確定した表示文字数。null なら再生位置に追従する */
  frozenLength: number | null;
  judgement: Judgement | null;
  error: string | null;
};

export type QuizAction =
  | { type: 'loadFailed'; message: string }
  | { type: 'ready' }
  /** 次の問題が用意できた。ジングル再生へ入る */
  | { type: 'questionLoaded'; question: Question }
  | { type: 'jingleEnded' }
  /** 早押し。その時点の表示文字数で問題文を止める */
  | { type: 'buzz'; visibleLength: number }
  /** 早押しされないまま音声が終わった */
  | { type: 'audioEnded'; visibleLength: number }
  | { type: 'judged'; judgement: Judgement }
  | { type: 'next' };

export const initialState: QuizState = {
  phase: 'loading',
  question: null,
  frozenLength: null,
  judgement: null,
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
        judgement: null,
        error: null,
      };

    case 'jingleEnded':
      // ジングルの再生完了を待ってから問題音声を始める
      return state.phase === 'jingle' ? { ...state, phase: 'reading' } : state;

    case 'buzz':
      return state.phase === 'reading'
        ? { ...state, phase: 'buzzed', frozenLength: action.visibleLength }
        : state;

    case 'audioEnded':
      return state.phase === 'reading'
        ? { ...state, phase: 'timeUp', frozenLength: action.visibleLength }
        : state;

    case 'judged':
      return state.phase === 'buzzed' || state.phase === 'timeUp'
        ? { ...state, phase: 'result', judgement: action.judgement }
        : state;

    case 'next':
      return { ...state, phase: 'idle', judgement: null, error: null };

    default:
      return state;
  }
}

/** 早押しを受け付けてよいか */
export function canBuzz(phase: Phase): boolean {
  return phase === 'reading';
}

/** 回答を入力できるか */
export function canAnswer(phase: Phase): boolean {
  return phase === 'buzzed' || phase === 'timeUp';
}
