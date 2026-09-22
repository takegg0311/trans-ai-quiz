/**
 * LLM 予測 API の呼び出し。
 *
 * API キーはブラウザに置けず、各社 API にはブラウザからの直接呼び出しに
 * CORS 制限があるため、server/ が中継する。開発時は vite.config.ts の
 * proxy が /api/llm を localhost:8000 へ送る。
 *
 * llm-poc/src/lib/llm.ts からの移植。/predict の呼び出しと応答の解釈は
 * そのまま使える。枠の選択（llmSlots.ts）と手動正解（useLlmPrediction.ts）は
 * 移植していない。対決の相手を毎回同じにするためモデルを固定しており、
 * 選択の保存も手動正解ボタンも要らないため。
 *
 * server が無くても早押しと手動回答は動く必要がある。疎通しない場合は
 * checkHealth が null を返し、呼び出し側が AI の回答を無効にする。
 */

const BASE = '/api/llm';

/** health の疎通確認が待つ時間。起動時に走るので短く切る */
const HEALTH_TIMEOUT_MS = 3000;

/**
 * 予測 1 件の上限。server 側も 60 秒で切るが、そちらが無反応な場合に
 * 備えてフロントでも同じだけ待って諦める。
 */
const PREDICT_TIMEOUT_MS = 60000;

export type ProviderInfo = {
  vendor: string;
  /** 画面に出す表示名 */
  label: string;
  available: boolean;
  models: string[];
  /** 使えない理由。キー未設定か未実装か */
  reason?: string;
};

/** 予測が成功した場合の結果 */
export type PredictSuccess = {
  status: 'ok';
  /** 補完後の問題文全文。読み切り時は返らないことがある */
  continuation: string | null;
  answer: string;
  elapsedMs: number;
  raw: string;
};

/**
 * 応答フォーマット違反。処理は成功しているが、モデルが指示に従わなかった。
 * エラーとは区別して扱う。
 */
export type PredictViolation = {
  status: 'violation';
  violation: string;
  elapsedMs: number;
  raw: string;
};

/**
 * サーバ側が返す失敗の種別。base.py の ErrorKind と対になる。
 * フロント都合の失敗（サーバへ届かなかった等）は 'network' / 'timeout' へ寄せる。
 */
export type ErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'unknown';

const ERROR_KINDS: readonly string[] = [
  'auth',
  'rate_limit',
  'timeout',
  'network',
  'bad_request',
  'unknown',
];

/** API エラーやネットワーク断 */
export type PredictError = {
  status: 'error';
  /**
   * 失敗の種別。message へ潰さず残すのは、どのモデルがどう落ちたかが
   * 比較実験の観測対象であり、CSV の error_kind 列に入るため。
   */
  kind: ErrorKind;
  message: string;
  elapsedMs: number;
};

export type PredictResult = PredictSuccess | PredictViolation | PredictError;

/**
 * 利用可能なプロバイダを問い合わせる。
 * server が起動していない場合は null を返す（エラーにしない）。
 */
export async function checkHealth(): Promise<ProviderInfo[] | null> {
  try {
    const response = await fetch(`${BASE}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;

    const providers = (body as { providers?: unknown }).providers;
    if (!Array.isArray(providers)) return null;

    return providers as ProviderInfo[];
  } catch {
    // server 未起動・プロキシ無し・タイムアウトはすべて「疎通しない」で扱う
    return null;
  }
}

/**
 * 問題文から答えを予測させる。
 *
 * partialText は画面で入力された問題文。complete が false なら
 * 「途中まで」として、続きの補完と答えの両方を求める。
 * 正解はこの API へ渡さない（判定はフロントで行い、記録は log へ送る）。
 */
export async function predict(
  vendor: string,
  model: string,
  partialText: string,
  complete: boolean,
): Promise<PredictResult> {
  const startedAt = performance.now();

  try {
    const response = await fetch(`${BASE}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vendor,
        model,
        partial_text: partialText,
        complete,
      }),
      signal: AbortSignal.timeout(PREDICT_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        status: 'error',
        kind: 'network',
        message: `サーバがエラーを返しました（HTTP ${response.status}）`,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    }

    return toResult(await response.json(), startedAt);
  } catch (reason: unknown) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (reason instanceof DOMException && reason.name === 'TimeoutError') {
      return {
        status: 'error',
        kind: 'timeout',
        message: `応答がありませんでした（${PREDICT_TIMEOUT_MS / 1000} 秒）`,
        elapsedMs,
      };
    }
    return {
      status: 'error',
      kind: 'network',
      message: reason instanceof Error ? reason.message : String(reason),
      elapsedMs,
    };
  }
}

/**
 * サーバの応答を画面用の形へ写す。
 *
 * サーバは違反もエラーも HTTP 200 で返す（枠ごとの失敗は画面に出す情報で
 * あってリクエスト自体の失敗ではないため）。ここで 3 通りへ振り分ける。
 */
function toResult(body: unknown, startedAt: number): PredictResult {
  const fallbackElapsed = Math.round(performance.now() - startedAt);

  if (typeof body !== 'object' || body === null) {
    return {
      status: 'error',
      kind: 'unknown',
      message: '応答を解釈できませんでした',
      elapsedMs: fallbackElapsed,
    };
  }

  const data = body as Record<string, unknown>;
  // 応答時間はサーバ側の実測（API 呼び出しのみ）を使う。
  // ネットワーク往復を含むフロント側の計測より、モデルの比較に適するため。
  const elapsedMs = typeof data.elapsed_ms === 'number' ? data.elapsed_ms : fallbackElapsed;
  const raw = typeof data.raw === 'string' ? data.raw : '';

  if (data.ok === true) {
    return {
      status: 'ok',
      continuation: typeof data.continuation === 'string' ? data.continuation : null,
      answer: typeof data.answer === 'string' ? data.answer : '',
      elapsedMs,
      raw,
    };
  }

  if (typeof data.violation === 'string') {
    return { status: 'violation', violation: data.violation, elapsedMs, raw };
  }

  return {
    status: 'error',
    kind: toErrorKind(data.error_kind),
    message: typeof data.error === 'string' ? data.error : '予測に失敗しました',
    elapsedMs,
  };
}

/** サーバの error_kind を型へ写す。知らない値は unknown へ寄せる */
function toErrorKind(value: unknown): ErrorKind {
  return typeof value === 'string' && ERROR_KINDS.includes(value)
    ? (value as ErrorKind)
    : 'unknown';
}
