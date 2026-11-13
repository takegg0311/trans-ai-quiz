import { describe, expect, it } from 'vitest';
import type { SlotState } from '../lib/useSlotJudge';
import { splitSlotText } from './ProviderSlot';

const base: SlotState = {
  liveLength: 0,
  display: null,
  judgement: null,
  error: null,
};

describe('splitSlotText', () => {
  it('読み上げ中は読まれた文字を白で出す', () => {
    const text = splitSlotText('あいうえお', { ...base, liveLength: 3 }, 3);
    expect(text).toEqual({ white: 'あいう', gray: '' });
  });

  it('押した枠は白と灰を分ける', () => {
    const text = splitSlotText('あいうえお', {
      ...base,
      display: { pressed: true, whiteLength: 2, grayLength: 4 },
    }, 4);
    expect(text).toEqual({ white: 'あい', gray: 'うえ' });
  });

  it('押さず読み切りは全文灰', () => {
    const text = splitSlotText('あいうえお', {
      ...base,
      display: { pressed: false, whiteLength: null, grayLength: 5 },
    }, 5);
    expect(text).toEqual({ white: '', gray: 'あいうえお' });
  });
});
