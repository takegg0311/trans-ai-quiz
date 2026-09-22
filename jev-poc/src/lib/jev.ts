/**
 * Jev 判定 API の呼び出し。
 *
 * API キーをブラウザに置けないため server/ が中継する。開発時は
 * vite.config.ts の proxy が /api/jev を localhost:8000 へ送る。
 *
 * server が無くても PoC は動く必要がある。疎通しない場合は checkHealth が
 * null を返し、呼び出し側が自動早押しを無効にして手動のみで動かす。
 */

const BASE = '/api/jev';

/** health の疎通確認が待つ時間。起動時に走るので短く切る */
const HEALTH_TIMEOUT_MS = 3000;

/**
 * 判定 1 件の上限。読み上げ中に連続で投げるため短く切る。
 * これを超えて届いた応答は、その頃には問題文が進んでおり使い道がない。
 */
const JUDGE_TIMEOUT_MS = 5000;

export type JevHealth = {
  available: boolean;
  model: string;
  /** narrowed の段階数。score の値域は 0〜(この値-1) */
  narrowedLevels: number;
  reason?: string;
};

/** 判定が成功した場合の観測値。質問が欠けていれば null になる */
export type JudgeSuccess = {
  status: 'ok';
  buzz: number | null;
  parallel: number | null;
  asking: number | null;
  narrowed: number | null;
  elapsedMs: number;
};

export type JudgeError = {
  status: 'error';
  message: string;
  elapsedMs: number;
};

export type JudgeResult = JudgeSuccess | JudgeError;

/**
 * Jev が使える状態かを問い合わせる。
 * server が起動していない場合は null を返す（エラーにしない）。
 */
export async function checkHealth(): Promise<JevHealth | null> {
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
      model: typeof data.model === 'string' ? data.model : '',
      narrowedLevels:
        typeof data.narrowed_levels === 'number' ? data.narrowed_levels : 0,
      reason: typeof data.reason === 'string' ? data.reason : undefined,
    };
  } catch {
    // server 未起動・プロキシ無し・タイムアウトはすべて「疎通しない」で扱う
    return null;
  }
}

/**
 * 読み上げ済みの問題文を評価する。
 *
 * 渡すのはその時点で画面に出ていた文字列だけ。問題文の全文と正解は
 * PoC が保持したままにし、サーバへは送らない。
 */
export async function judge(partialText: string): Promise<JudgeResult> {
  const startedAt = performance.now();

  try {
    const response = await fetch(`${BASE}/judge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partial_text: partialText }),
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

/**
 * サーバの応答を画面用の形へ写す。
 *
 * サーバは失敗も HTTP 200 で返す（読み上げ中は次の文字で再送されるため、
 * 1 回の失敗はリクエストの失敗ではない）。ここで 2 通りへ振り分ける。
 */
function toResult(body: unknown, startedAt: number): JudgeResult {
  const fallbackElapsed = Math.round(performance.now() - startedAt);

  if (typeof body !== 'object' || body === null) {
    return { status: 'error', message: '応答を解釈できませんでした', elapsedMs: fallbackElapsed };
  }

  const data = body as Record<string, unknown>;
  // 応答時間はサーバ側の実測を使う。ネットワーク往復を含むフロント側の
  // 計測より、判定の速さを見るのに適するため。
  const elapsedMs = typeof data.elapsed_ms === 'number' ? data.elapsed_ms : fallbackElapsed;

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

/** 値が無いことと 0 であることを取り違えないため、欠測は null で残す */
function toNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
