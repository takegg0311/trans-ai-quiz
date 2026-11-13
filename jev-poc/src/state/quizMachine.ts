/**
 * 出題サイクルの状態遷移（判定比較用）。
 *
 *   idle ──start──▶ loading ──questionLoaded──▶ jingle ──jingleEnded──▶ reading
 *                     │                                              │
 *                loadFailed                                     audioEnded
 *                     ▼                                              ▼
 *                   idle                                         readEnded ──reveal──▶ reveal
 *                                                                     ▲                   │
 *                                                                     └── close ◀─────────┤
 *                                                                                         │
 *                                                      idle ◀── next ─────────────────────┘
 *
 * 人間の早押し・LLM 回答・正誤判定は持たない。3 枠の押しポイントを
 * 並べて比べるのが目的のため。
 *
 * start で loading に移すのは、問題データの await 中に「出題する」の連打や
 * 枠トグルが通らないようにするため。初期の manifest 読み込みも同じ loading を使う。
 */
import type { Question } from '../lib/manifest';

export type Phase =
  | 'loading'
  | 'idle'
  | 'jingle'
  | 'reading'
  | 'readEnded'
  | 'reveal';

export type QuizState = {
  phase: Phase;
  question: Question | null;
  error: string | null;
};

export type QuizAction =
  | { type: 'loadFailed'; message: string }
  | { type: 'ready' }
  | { type: 'start' }
  | { type: 'questionLoaded'; question: Question }
  | { type: 'jingleEnded' }
  | { type: 'audioEnded' }
  | { type: 'openReveal' }
  | { type: 'closeReveal' }
  | { type: 'next' };

export const initialState: QuizState = {
  phase: 'loading',
  question: null,
  error: null,
};

export function quizReducer(state: QuizState, action: QuizAction): QuizState {
  switch (action.type) {
    case 'loadFailed':
      return { ...state, phase: 'idle', error: action.message };

    case 'ready':
      return { ...state, phase: 'idle', error: null };

    case 'start':
      // idle 以外からの start は無視（連打で二重に出題を始めない）
      return state.phase === 'idle'
        ? { ...state, phase: 'loading', error: null }
        : state;

    case 'questionLoaded':
      return {
        ...state,
        phase: 'jingle',
        question: action.question,
        error: null,
      };

    case 'jingleEnded':
      return state.phase === 'jingle' ? { ...state, phase: 'reading' } : state;

    case 'audioEnded':
      return state.phase === 'reading' ? { ...state, phase: 'readEnded' } : state;

    case 'openReveal':
      return state.phase === 'readEnded' || state.phase === 'reveal'
        ? { ...state, phase: 'reveal' }
        : state;

    case 'closeReveal':
      // × で閉じても readEnded のまま。全文・正解確認で開き直せる
      return state.phase === 'reveal' ? { ...state, phase: 'readEnded' } : state;

    case 'next':
      return { ...state, phase: 'idle', question: null, error: null };

    default:
      return state;
  }
}

/** 「出題する」を押せるか（呼び出し側が health / ON も見る） */
export function canStart(phase: Phase): boolean {
  return phase === 'idle';
}

/** 「全文・正解確認」を押せるか */
export function canReveal(phase: Phase): boolean {
  return phase === 'readEnded';
}
