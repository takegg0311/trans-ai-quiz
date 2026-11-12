/**
 * 枠の ON/OFF を localStorage に残す。
 *
 * 保存するのは、ユーザーが待機中にトグルで切り替えた値だけ。
 * キーの無い provider を OFF 表示にするときは保存値を書き換えない。
 */

export type ProviderId = 'typesafe' | 'openai' | 'gemini';

export const PROVIDER_IDS: readonly ProviderId[] = [
  'typesafe',
  'openai',
  'gemini',
] as const;

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  typesafe: 'Jev',
  openai: 'OpenAI',
  gemini: 'Gemini',
};

const STORAGE_KEY = 'jev-poc.provider-enabled';

export type EnabledMap = Record<ProviderId, boolean>;

/** 保存が無い枠は ON で始める */
export const DEFAULT_ENABLED: EnabledMap = {
  typesafe: true,
  openai: true,
  gemini: true,
};

export function loadEnabled(): EnabledMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_ENABLED };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_ENABLED };
    const data = parsed as Record<string, unknown>;
    return {
      typesafe: data.typesafe !== false,
      openai: data.openai !== false,
      gemini: data.gemini !== false,
    };
  } catch {
    return { ...DEFAULT_ENABLED };
  }
}

export function saveEnabled(enabled: EnabledMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
}

/**
 * 画面に出す実効 ON/OFF。
 *
 * available が false の枠は OFF 表示にするが、保存値は変えない。
 * health 未取得（providers が空 / 疎通失敗）のときは全枠を無効にする。
 */
export function effectiveEnabled(
  saved: EnabledMap,
  available: Record<ProviderId, boolean> | null,
): EnabledMap {
  if (available === null) {
    return { typesafe: false, openai: false, gemini: false };
  }
  return {
    typesafe: saved.typesafe && available.typesafe,
    openai: saved.openai && available.openai,
    gemini: saved.gemini && available.gemini,
  };
}
