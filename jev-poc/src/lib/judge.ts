/**
 * 早押し判定 API の呼び出し。
 *
 * API キーをブラウザに置けないため server/ が中継する。開発時は
 * vite.config.ts の proxy が /api/judge を localhost:8000 へ送る。
 */

const BASE = '/api/judge';

const HEALTH_TIMEOUT_MS = 3000;
const JUDGE_TIMEOUT_MS = 5000;

export type JudgeProviderInfo = {
  id: string;
  label: string;
  model: string;
  available: boolean;
  reason?: string;
};

export type JudgeHealth = {
  available: boolean;
  provider: string;
  model: string;
  narrowedLevels: number;
  readingEndedDelayMs: number;
  reason?: string;
  providers: JudgeProviderInfo[];
};

export type JudgeSuccess = {
  status: 'ok';
  buzz: number | null;
  parallel: number | null;
  asking: number | null;
  narrowed: number | null;
  elapsedMs: number;
};

export type JudgeErrorResult = {
  status: 'error';
  message: string;
  elapsedMs: number;
};

export type JudgeResult = JudgeSuccess | JudgeErrorResult;

export async function checkHealth(): Promise<JudgeHealth | null> {
  try {
    const response = await fetch(`${BASE}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;

    const data = body as Record<string, unknown>;
    return {
      available: data.available === true,
      provider: typeof data.provider === 'string' ? data.provider : '',
      model: typeof data.model === 'string' ? data.model : '',
      narrowedLevels:
        typeof data.narrowed_levels === 'number' ? data.narrowed_levels : 0,
      readingEndedDelayMs:
        typeof data.reading_ended_delay_ms === 'number'
          ? data.reading_ended_delay_ms
          : 0,
      reason: typeof data.reason === 'string' ? data.reason : undefined,
      providers: parseProviders(data.providers),
    };
  } catch {
    return null;
  }
}

export async function judge(
  partialText: string,
  provider: string,
): Promise<JudgeResult> {
  const startedAt = performance.now();

  try {
    const response = await fetch(`${BASE}/judge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partial_text: partialText, provider }),
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        status: 'error',
        message: `サーバがエラーを返しました（HTTP ${response.status}）`,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    }

    return toResult(await response.json(), startedAt);
  } catch (reason: unknown) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (reason instanceof DOMException && reason.name === 'TimeoutError') {
      return { status: 'error', message: '応答がありませんでした', elapsedMs };
    }
    return {
      status: 'error',
      message: reason instanceof Error ? reason.message : String(reason),
      elapsedMs,
    };
  }
}

function parseProviders(value: unknown): JudgeProviderInfo[] {
  if (!Array.isArray(value)) return [];
  const providers: JudgeProviderInfo[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const data = item as Record<string, unknown>;
    if (typeof data.id !== 'string') continue;
    providers.push({
      id: data.id,
      label: typeof data.label === 'string' ? data.label : data.id,
      model: typeof data.model === 'string' ? data.model : '',
      available: data.available === true,
      reason: typeof data.reason === 'string' ? data.reason : undefined,
    });
  }
  return providers;
}

function toResult(body: unknown, startedAt: number): JudgeResult {
  const fallbackElapsed = Math.round(performance.now() - startedAt);

  if (typeof body !== 'object' || body === null) {
    return {
      status: 'error',
      message: '応答を解釈できませんでした',
      elapsedMs: fallbackElapsed,
    };
  }

  const data = body as Record<string, unknown>;
  const elapsedMs =
    typeof data.elapsed_ms === 'number' ? data.elapsed_ms : fallbackElapsed;

  if (data.ok === true) {
    return {
      status: 'ok',
      buzz: toNumber(data.buzz),
      parallel: toNumber(data.parallel),
      asking: toNumber(data.asking),
      narrowed: toNumber(data.narrowed),
      elapsedMs,
    };
  }

  return {
    status: 'error',
    message: typeof data.error === 'string' ? data.error : '判定に失敗しました',
    elapsedMs,
  };
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
