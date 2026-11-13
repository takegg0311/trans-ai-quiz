import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ENABLED,
  effectiveEnabled,
  loadEnabled,
  saveEnabled,
} from './providerPrefs';

describe('providerPrefs', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('保存の無い枠は ON で始まる', () => {
    expect(loadEnabled()).toEqual(DEFAULT_ENABLED);
  });

  it('available: false の枠は OFF 表示だが保存値は変わらない', () => {
    saveEnabled({ typesafe: true, openai: true, gemini: false });
    const saved = loadEnabled();
    const view = effectiveEnabled(saved, {
      typesafe: true,
      openai: false,
      gemini: true,
    });
    expect(view).toEqual({
      typesafe: true,
      openai: false,
      gemini: false,
    });
    expect(loadEnabled()).toEqual({
      typesafe: true,
      openai: true,
      gemini: false,
    });
  });

  it('available が true に戻ると保存値に戻る', () => {
    saveEnabled({ typesafe: false, openai: true, gemini: true });
    const saved = loadEnabled();
    expect(
      effectiveEnabled(saved, {
        typesafe: false,
        openai: true,
        gemini: true,
      }).typesafe,
    ).toBe(false);
    expect(
      effectiveEnabled(saved, {
        typesafe: true,
        openai: true,
        gemini: true,
      }).typesafe,
    ).toBe(false);
  });

  it('health 未取得なら全枠無効', () => {
    expect(effectiveEnabled(DEFAULT_ENABLED, null)).toEqual({
      typesafe: false,
      openai: false,
      gemini: false,
    });
  });
});

describe('providers[] だけで可否を決める', () => {
  it('トップレベルの available は見ない（providers の available だけ）', () => {
    // effectiveEnabled は providers 由来の available map だけを受け取る。
    // トップレベル available: false でも、map 上 true なら ON にできる。
    const view = effectiveEnabled(
      { typesafe: true, openai: true, gemini: true },
      { typesafe: true, openai: false, gemini: true },
    );
    expect(view.typesafe).toBe(true);
    expect(view.gemini).toBe(true);
    expect(view.openai).toBe(false);
  });
});
