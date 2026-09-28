/**
 * 予測文の分割のテスト。
 *
 * 分け方を誤ると「読まれた部分」を偽って見せることになるため、
 * 前方一致しない場合に分けないことも固定する。
 */
import { describe, expect, it } from 'vitest';
import { splitContinuation } from './continuation';

describe('splitContinuation', () => {
  it('送った文で始まる予測文は、読み上げ済みと予測部分に分ける', () => {
    const result = splitContinuation(
      '日本で一番高い山は富士山ですが、二番目に高い山は何でしょう？',
      '日本で一番高い山は',
    );
    expect(result).toEqual({
      kind: 'split',
      read: '日本で一番高い山は',
      predicted: '富士山ですが、二番目に高い山は何でしょう？',
    });
  });

  it('前方一致しない予測文は分けずに全体を返す', () => {
    const result = splitContinuation(
      '日本一高い山は富士山ですが、二番目に高い山は何でしょう？',
      '日本で一番高い山は',
    );
    expect(result).toEqual({
      kind: 'whole',
      text: '日本一高い山は富士山ですが、二番目に高い山は何でしょう？',
    });
  });

  it('空白の違いも一致とみなさない', () => {
    const result = splitContinuation('日本で 一番高い山は富士山', '日本で一番高い山は');
    expect(result.kind).toBe('whole');
  });

  it('予測文が送った文と同じなら、予測部分は空になる', () => {
    const result = splitContinuation('日本で一番高い山は？', '日本で一番高い山は？');
    expect(result).toEqual({ kind: 'split', read: '日本で一番高い山は？', predicted: '' });
  });

  it('送った文が空なら分けない', () => {
    const result = splitContinuation('富士山', '');
    expect(result).toEqual({ kind: 'whole', text: '富士山' });
  });
});
