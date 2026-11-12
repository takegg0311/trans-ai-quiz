import { describe, expect, it } from 'vitest';
import { shouldEndSilentReading } from './silentReading';

describe('shouldEndSilentReading', () => {
  it('音声あり問題では全枠が押しても読み切りにならない', () => {
    expect(
      shouldEndSilentReading({
        hasAudio: true,
        shownLength: 5,
        totalLength: 20,
        activePressed: [true, true, true],
      }),
    ).toBe(false);
  });

  it('音声なしで ON の枠がすべて押したら読み切り', () => {
    expect(
      shouldEndSilentReading({
        hasAudio: false,
        shownLength: 5,
        totalLength: 20,
        activePressed: [true, true],
      }),
    ).toBe(true);
  });

  it('音声なしで全文を出し終えたら読み切り', () => {
    expect(
      shouldEndSilentReading({
        hasAudio: false,
        shownLength: 20,
        totalLength: 20,
        activePressed: [false],
      }),
    ).toBe(true);
  });

  it('音声なしでまだ押していない枠があれば読み切りにしない', () => {
    expect(
      shouldEndSilentReading({
        hasAudio: false,
        shownLength: 5,
        totalLength: 20,
        activePressed: [true, false],
      }),
    ).toBe(false);
  });
});
