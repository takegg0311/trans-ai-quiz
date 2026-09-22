/**
 * 合議の規則のテスト。
 *
 * 勝敗に直結する部分であり、規則を変えたときに気づけるよう固定する。
 * 「最初に回答を出した」をサーバ実測の elapsed_ms で測ることも、
 * ここで期待値として残す。
 */
import { describe, expect, it } from 'vitest';
import { decideConsensus, type ModelAnswer } from './consensus';
import type { PredictResult } from './llm';

function ok(answer: string, elapsedMs: number): PredictResult {
  return { status: 'ok', continuation: null, answer, elapsedMs, raw: '' };
}

function violation(elapsedMs: number): PredictResult {
  return { status: 'violation', violation: 'JSON として解釈できません', elapsedMs, raw: '' };
}

function error(elapsedMs: number): PredictResult {
  return { status: 'error', kind: 'timeout', message: '応答がありません', elapsedMs };
}

function entry(model: string, result: PredictResult): ModelAnswer {
  return { vendor: 'test', model, result };
}

describe('多数決', () => {
  it('2 モデルが同じ回答ならそれを採用する', () => {
    const result = decideConsensus([
      entry('a', ok('富士山', 1000)),
      entry('b', ok('エベレスト', 500)),
      entry('c', ok('富士山', 1500)),
    ]);

    // 最速は b（500ms）だが、多数決が優先される
    expect(result.answer).toBe('富士山');
    expect(result.reason).toBe('majority');
    expect(result.supporters.map((s) => s.model)).toEqual(['a', 'c']);
    expect(result.participants).toBe(3);
  });

  it('3 モデルが同じ回答ならそれを採用する', () => {
    const result = decideConsensus([
      entry('a', ok('富士山', 1000)),
      entry('b', ok('富士山', 500)),
      entry('c', ok('富士山', 1500)),
    ]);

    expect(result.answer).toBe('富士山');
    expect(result.reason).toBe('majority');
    expect(result.supporters).toHaveLength(3);
  });

  it('括弧の有無で多数決が割れない', () => {
    // 実測で起きたケース。Claude と Grok が「檸檬」、Gemini が「『檸檬』」を
    // 返した。LLM は作品名を括って返すことがあり、括弧を残すと
    // 実質同じ答えなのに別グループへ分かれる。
    const result = decideConsensus([
      entry('claude', ok('檸檬', 3045)),
      entry('gemini', ok('『檸檬』', 2736)),
      entry('grok', ok('檸檬', 4911)),
    ]);

    expect(result.reason).toBe('majority');
    expect(result.supporters).toHaveLength(3);
  });

  it('表記が揺れていても同じ回答として数える', () => {
    // 正規化で揃えないと、実質同じ答えなのに最速採用へ落ちる
    const result = decideConsensus([
      entry('a', ok('Ｐｙｔｈｏｎ', 1000)),
      entry('b', ok('エベレスト', 500)),
      entry('c', ok('python', 1500)),
    ]);

    expect(result.reason).toBe('majority');
    expect(result.supporters.map((s) => s.model)).toEqual(['a', 'c']);
  });
});

describe('最速採用', () => {
  it('3 モデルが異なる回答なら最速のものを採用する', () => {
    const result = decideConsensus([
      entry('a', ok('富士山', 1000)),
      entry('b', ok('エベレスト', 500)),
      entry('c', ok('北岳', 1500)),
    ]);

    expect(result.answer).toBe('エベレスト');
    expect(result.reason).toBe('fastest');
    expect(result.supporters.map((s) => s.model)).toEqual(['b']);
    expect(result.participants).toBe(3);
  });

  it('到着順ではなく elapsed_ms で決める', () => {
    // 配列の順序（到着順に相当）は最速と一致しない
    const result = decideConsensus([
      entry('first', ok('A', 2000)),
      entry('second', ok('B', 100)),
      entry('third', ok('C', 900)),
    ]);

    expect(result.answer).toBe('B');
  });
});

describe('一部失敗', () => {
  it('成功した 2 モデルが一致すれば多数決が成立する', () => {
    const result = decideConsensus([
      entry('a', ok('富士山', 1000)),
      entry('b', error(60000)),
      entry('c', ok('富士山', 1500)),
    ]);

    expect(result.answer).toBe('富士山');
    expect(result.reason).toBe('majority');
    expect(result.participants).toBe(2);
  });

  it('成功した 2 モデルが異なれば最速を採用する', () => {
    const result = decideConsensus([
      entry('a', ok('富士山', 1000)),
      entry('b', violation(300)),
      entry('c', ok('エベレスト', 1500)),
    ]);

    expect(result.answer).toBe('富士山');
    expect(result.reason).toBe('fastest');
    expect(result.participants).toBe(2);
  });

  it('1 モデルしか成功しなければその回答を採用する', () => {
    const result = decideConsensus([
      entry('a', error(60000)),
      entry('b', ok('エベレスト', 800)),
      entry('c', violation(400)),
    ]);

    expect(result.answer).toBe('エベレスト');
    expect(result.reason).toBe('fastest');
    expect(result.participants).toBe(1);
  });

  it('応答フォーマット違反は合議に参加しない', () => {
    // 違反は「処理は成功したが答えを持たない」。エラーとは別だが、
    // 答えが無い以上は合議へ入れられない
    const result = decideConsensus([
      entry('a', violation(100)),
      entry('b', violation(200)),
      entry('c', ok('富士山', 5000)),
    ]);

    expect(result.answer).toBe('富士山');
    expect(result.participants).toBe(1);
  });

  it('答えが空文字なら参加しない', () => {
    const result = decideConsensus([
      entry('a', ok('   ', 100)),
      entry('b', ok('富士山', 900)),
      entry('c', ok('', 200)),
    ]);

    expect(result.answer).toBe('富士山');
    expect(result.participants).toBe(1);
  });
});

describe('全滅', () => {
  it('全モデルが失敗したら回答なしになる', () => {
    const result = decideConsensus([
      entry('a', error(60000)),
      entry('b', error(60000)),
      entry('c', violation(500)),
    ]);

    expect(result.answer).toBeNull();
    expect(result.reason).toBe('none');
    expect(result.supporters).toHaveLength(0);
    expect(result.participants).toBe(0);
  });

  it('空の配列でも壊れない', () => {
    const result = decideConsensus([]);

    expect(result.answer).toBeNull();
    expect(result.reason).toBe('none');
  });
});
