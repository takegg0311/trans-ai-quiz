import { describe, expect, it } from 'vitest';
import type { Question } from '../lib/manifest';
import {
  canReveal,
  canStart,
  initialState,
  quizReducer,
} from './quizMachine';

const question = {
  id: 'q1',
  audioUrl: '/a.wav',
  text: '日本で一番高い山は',
  answers: ['富士山'],
  lab: { phones: [] },
  alignment: { chars: [], duration: 1 },
} as unknown as Question;

describe('quizMachine', () => {
  it('待機 → jingle → reading → readEnded → reveal → 待機', () => {
    let state = initialState;
    state = quizReducer(state, { type: 'ready' });
    expect(state.phase).toBe('idle');
    expect(canStart(state.phase)).toBe(true);

    state = quizReducer(state, { type: 'questionLoaded', question });
    expect(state.phase).toBe('jingle');

    state = quizReducer(state, { type: 'jingleEnded' });
    expect(state.phase).toBe('reading');
    expect(canReveal(state.phase)).toBe(false);

    state = quizReducer(state, { type: 'audioEnded' });
    expect(state.phase).toBe('readEnded');
    expect(canReveal(state.phase)).toBe(true);

    state = quizReducer(state, { type: 'openReveal' });
    expect(state.phase).toBe('reveal');

    state = quizReducer(state, { type: 'next' });
    expect(state.phase).toBe('idle');
    expect(state.question).toBeNull();
  });

  it('× で閉じても readEnded のまま', () => {
    let state = quizReducer(initialState, { type: 'ready' });
    state = quizReducer(state, { type: 'questionLoaded', question });
    state = quizReducer(state, { type: 'jingleEnded' });
    state = quizReducer(state, { type: 'audioEnded' });
    state = quizReducer(state, { type: 'openReveal' });
    state = quizReducer(state, { type: 'closeReveal' });
    expect(state.phase).toBe('readEnded');
  });
});
