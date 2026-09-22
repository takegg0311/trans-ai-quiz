/**
 * 出題サイクルの遷移のテスト。
 *
 * AI の回答を挟むことで、遷移が一方向でなくなった。
 * **AI が誤答すると reading へ戻る**のがこの PoC で新しい部分であり、
 * 戻り先の状態（表示の追従が再開するか、灰色表示が消えるか）を固定する。
 */
import { describe, expect, it } from 'vitest';
import type { Consensus } from '../lib/consensus';
import type { Question } from '../lib/manifest';
import { canAnswer, canBuzz, initialState, quizReducer, type QuizState } from './quizMachine';

const QUESTION = {
  id: 'test/0',
  audioUrl: '/dummy.wav',
  text: '日本で最も高い山は何でしょう？',
  answers: ['富士山'],
  lab: { phonemes: [], segments: [], duration: 0 },
  alignment: { text: '', chunks: [] },
} as unknown as Question;

const CONSENSUS: Consensus = {
  answer: '富士山',
  reason: 'majority',
  supporters: [{ vendor: 'anthropic', model: 'claude-sonnet-5' }],
  participants: 3,
};

/** reading まで進めた状態を作る */
function reading(): QuizState {
  let state = quizReducer(initialState, { type: 'ready' });
  state = quizReducer(state, { type: 'questionLoaded', question: QUESTION });
  return quizReducer(state, { type: 'jingleEnded' });
}

describe('人間の早押し', () => {
  it('reading から buzzed へ進む', () => {
    const state = quizReducer(reading(), { type: 'buzz', visibleLength: 10 });

    expect(state.phase).toBe('buzzed');
    expect(state.frozenLength).toBe(10);
    // 人間が押した場合は判定位置を持たない（灰色表示をしない）
    expect(state.judgedLength).toBeNull();
    expect(canAnswer(state.phase)).toBe(true);
  });

  it('reading 以外では押せない', () => {
    const buzzed = quizReducer(reading(), { type: 'buzz', visibleLength: 10 });
    const again = quizReducer(buzzed, { type: 'buzz', visibleLength: 20 });

    expect(again.frozenLength).toBe(10);
  });
});

describe('Jev の早押し', () => {
  it('reading から aiAnswering へ進む', () => {
    const state = quizReducer(reading(), {
      type: 'aiBuzz',
      visibleLength: 15,
      judgedLength: 12,
    });

    expect(state.phase).toBe('aiAnswering');
    expect(state.frozenLength).toBe(15);
    expect(state.judgedLength).toBe(12);
  });

  it('回答待ちの間は人間が早押しできない', () => {
    const state = quizReducer(reading(), {
      type: 'aiBuzz',
      visibleLength: 15,
      judgedLength: 12,
    });

    expect(canBuzz(state.phase)).toBe(false);
    expect(canAnswer(state.phase)).toBe(false);
  });
});

describe('AI の回答が出そろったとき', () => {
  function answering(): QuizState {
    return quizReducer(reading(), { type: 'aiBuzz', visibleLength: 15, judgedLength: 12 });
  }

  it('正解なら AI の勝ちとして result へ進む', () => {
    const state = quizReducer(answering(), {
      type: 'aiSettled',
      answer: '富士山',
      consensus: CONSENSUS,
      correct: true,
    });

    expect(state.phase).toBe('result');
    expect(state.judgement).toEqual({ input: '富士山', correct: true, by: 'ai' });
    expect(state.aiAttempt?.answer).toBe('富士山');
  });

  it('誤答なら reading へ戻り、人間へ解答権が移る', () => {
    const state = quizReducer(answering(), {
      type: 'aiSettled',
      answer: 'エベレスト',
      consensus: { ...CONSENSUS, answer: 'エベレスト' },
      correct: false,
    });

    expect(state.phase).toBe('reading');
    expect(canBuzz(state.phase)).toBe(true);
    // 表示の追従を再開させる
    expect(state.frozenLength).toBeNull();
    // 灰色表示は「AI が見ていた範囲」。権利が移った後は意味を持たない
    expect(state.judgedLength).toBeNull();
    // 判定はまだ確定していない
    expect(state.judgement).toBeNull();
  });

  it('誤答でも AI が何を答えたかは残る', () => {
    const state = quizReducer(answering(), {
      type: 'aiSettled',
      answer: 'エベレスト',
      consensus: { ...CONSENSUS, answer: 'エベレスト' },
      correct: false,
    });

    expect(state.aiAttempt?.answer).toBe('エベレスト');
  });

  it('全滅（回答なし）でも reading へ戻る', () => {
    const state = quizReducer(answering(), {
      type: 'aiSettled',
      answer: null,
      consensus: { answer: null, reason: 'none', supporters: [], participants: 0 },
      correct: false,
    });

    expect(state.phase).toBe('reading');
    expect(state.aiAttempt?.answer).toBeNull();
  });

  it('aiAnswering 以外では無視する', () => {
    const state = quizReducer(reading(), {
      type: 'aiSettled',
      answer: '富士山',
      consensus: CONSENSUS,
      correct: true,
    });

    expect(state.phase).toBe('reading');
  });
});

describe('AI 誤答後の続き', () => {
  function afterAiWrong(): QuizState {
    const answering = quizReducer(reading(), {
      type: 'aiBuzz',
      visibleLength: 15,
      judgedLength: 12,
    });
    return quizReducer(answering, {
      type: 'aiSettled',
      answer: 'エベレスト',
      consensus: { ...CONSENSUS, answer: 'エベレスト' },
      correct: false,
    });
  }

  it('人間が押し直せる', () => {
    const state = quizReducer(afterAiWrong(), { type: 'buzz', visibleLength: 25 });

    expect(state.phase).toBe('buzzed');
    expect(state.frozenLength).toBe(25);
  });

  it('読み切られれば timeUp へ進む', () => {
    const state = quizReducer(afterAiWrong(), { type: 'audioEnded', visibleLength: 30 });

    expect(state.phase).toBe('timeUp');
    expect(canAnswer(state.phase)).toBe(true);
  });

  it('人間が答えれば by: human の判定になる', () => {
    const buzzed = quizReducer(afterAiWrong(), { type: 'buzz', visibleLength: 25 });
    const state = quizReducer(buzzed, {
      type: 'judged',
      judgement: { input: '富士山', correct: true, by: 'human' },
    });

    expect(state.phase).toBe('result');
    expect(state.judgement?.by).toBe('human');
    // AI が誤答していた事実も残る
    expect(state.aiAttempt?.answer).toBe('エベレスト');
  });
});

describe('次の問題へ', () => {
  it('AI の回答結果を持ち越さない', () => {
    const answering = quizReducer(reading(), {
      type: 'aiBuzz',
      visibleLength: 15,
      judgedLength: 12,
    });
    const settled = quizReducer(answering, {
      type: 'aiSettled',
      answer: '富士山',
      consensus: CONSENSUS,
      correct: true,
    });
    const next = quizReducer(settled, { type: 'next' });

    expect(next.aiAttempt).toBeNull();
    expect(next.judgement).toBeNull();
  });
});
