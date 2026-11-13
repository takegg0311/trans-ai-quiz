import { describe, expect, it } from 'vitest';
import { readEndedDisplay, resolvePress } from './slotPress';

describe('resolvePress', () => {
  it('基準位置で文字が残っていれば押した', () => {
    const result = resolvePress(10, 14, 20);
    expect(result.pressed).toBe(true);
    expect(result.whiteLength).toBe(10);
    expect(result.grayLength).toBe(14);
  });

  it('応答が読み切り後に届いても基準位置に残りがあれば押した', () => {
    const result = resolvePress(18, 20, 20);
    expect(result.pressed).toBe(true);
    expect(result.whiteLength).toBe(18);
    expect(result.grayLength).toBe(20);
  });

  it('基準位置が全文の長さと同じなら押していない', () => {
    const result = resolvePress(20, 20, 20);
    expect(result.pressed).toBe(false);
    expect(result.whiteLength).toBeNull();
  });

  it('白と灰の範囲が独立して記録される', () => {
    const a = resolvePress(5, 8, 30);
    const b = resolvePress(12, 15, 30);
    expect(a.whiteLength).toBe(5);
    expect(a.grayLength).toBe(8);
    expect(b.whiteLength).toBe(12);
    expect(b.grayLength).toBe(15);
  });
});

describe('readEndedDisplay', () => {
  it('全文を灰にする', () => {
    expect(readEndedDisplay(12)).toEqual({
      pressed: false,
      whiteLength: null,
      grayLength: 12,
    });
  });
});
