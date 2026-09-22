/**
 * 3 モデルの応答から、AI の答えを 1 つ決める。
 *
 * 対決の相手は 1 人（1 つの答え）でなければ勝敗がつかない。一方で単一モデルに
 * すると、そのモデルの当たり外れがそのまま結果になる。複数を並べて多数決を
 * 取ることで、AI 側の実力をより安定して測る。
 *
 * 規則:
 *   1. 2 モデル以上が同じ回答 → それを採用
 *   2. 3 モデルがそれぞれ異なる → 最初に回答を出したモデルを採用
 *   3. 一部が失敗 → 成功したモデルだけで 1〜2 を適用
 *   4. 全モデルが失敗 → 回答なし（AI の誤答として扱う）
 *
 * **多数決が覆らなくなった時点で打ち切る**（canSettleEarly）。早押しでは
 * 回答までの速さも勝敗に関わるため、結果が決まっている応答を待たない。
 * 残りの応答は届き次第、画面の表示だけ更新する。
 *
 * 「最初に回答を出した」はサーバ実測の elapsed_ms で測る。フロントへの到着順は
 * ネットワークのゆらぎで変わり、モデルの速さを表さないため採らない。
 */
import { normalizeAnswer } from './answer';
import type { PredictResult } from './llm';

/** 合議に参加する 1 モデル分の応答 */
export type ModelAnswer = {
  vendor: string;
  model: string;
  result: PredictResult;
};

/** どの規則で答えが決まったか。画面とログに出す */
export type ConsensusReason = 'majority' | 'fastest' | 'none';

export type Consensus = {
  /** 採用した答え。全滅なら null */
  answer: string | null;
  reason: ConsensusReason;
  /** この答えを出したモデル。多数決なら複数、最速採用なら 1 つ */
  supporters: { vendor: string; model: string }[];
  /** 合議に参加できたモデル数（成功したもの） */
  participants: number;
};

/**
 * 応答から答えの文字列を取り出す。
 *
 * 成功（status: 'ok'）で、かつ答えが空でないものだけを合議へ入れる。
 * 応答フォーマット違反とエラーは、答えを持たないため参加できない。
 */
function usableAnswer(entry: ModelAnswer): string | null {
  if (entry.result.status !== 'ok') return null;
  const answer = entry.result.answer.trim();
  return answer === '' ? null : answer;
}

/** 応答時間。成功した応答のみ呼ぶ */
function elapsedOf(entry: ModelAnswer): number {
  return entry.result.elapsedMs;
}

/**
 * 3 モデルの応答から答えを決める。
 *
 * 同じ回答かどうかは、正誤判定と同じ正規化で比べる。表記揺れ（「富士山」と
 * 「ふじさん」）で多数決が割れると、実質同じ答えなのに最速採用へ落ちてしまう。
 */
export function decideConsensus(entries: ModelAnswer[]): Consensus {
  const usable = entries
    .map((entry) => ({ entry, answer: usableAnswer(entry) }))
    .filter((item): item is { entry: ModelAnswer; answer: string } => item.answer !== null);

  if (usable.length === 0) {
    return { answer: null, reason: 'none', supporters: [], participants: 0 };
  }

  // 正規化した答えでまとめる。表示には最初に出てきた生の答えを使う
  const groups = new Map<string, { answer: string; items: typeof usable }>();
  for (const item of usable) {
    const key = normalizeAnswer(item.answer);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { answer: item.answer, items: [item] });
    } else {
      group.items.push(item);
    }
  }

  // 2 票以上のグループがあれば多数決。同数で並ぶ場合は、より速い方を採る
  const majority = [...groups.values()]
    .filter((group) => group.items.length >= 2)
    .sort((a, b) => {
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      return fastestElapsed(a.items) - fastestElapsed(b.items);
    })[0];

  if (majority !== undefined) {
    return {
      answer: majority.answer,
      reason: 'majority',
      supporters: majority.items.map((item) => ({
        vendor: item.entry.vendor,
        model: item.entry.model,
      })),
      participants: usable.length,
    };
  }

  // 全員が違う答え（または 1 体しか成功していない）。最も速く返したものを採る
  const fastest = usable.reduce((best, item) =>
    elapsedOf(item.entry) < elapsedOf(best.entry) ? item : best,
  );

  return {
    answer: fastest.answer,
    reason: 'fastest',
    supporters: [{ vendor: fastest.entry.vendor, model: fastest.entry.model }],
    participants: usable.length,
  };
}

function fastestElapsed(items: { entry: ModelAnswer }[]): number {
  return Math.min(...items.map((item) => elapsedOf(item.entry)));
}

/**
 * 残りの応答を待たずに合議を確定してよいか。
 *
 * 届いている回答だけで多数決が決まり、**まだ届いていないモデルが何を答えても
 * 結果が変わらない**場合に true を返す。
 *
 * 3 モデルなら「2 つが一致した時点」がこれにあたる。残る 1 つが何を答えても、
 * 一致している 2 票を超えることはない。
 *
 * 安全側に倒す設計であり、判断に迷う場合は false を返して全応答を待つ。
 * 早く確定することより、確定した答えが最終結果と一致することを優先する。
 *
 * @param settled 既に届いている応答
 * @param total   送信したモデル数（まだ届いていないものを含む）
 */
export function canSettleEarly(settled: ModelAnswer[], total: number): boolean {
  const pending = total - settled.length;
  if (pending <= 0) return true;

  const counts = new Map<string, number>();
  for (const entry of settled) {
    const answer = usableAnswer(entry);
    if (answer === null) continue;
    const key = normalizeAnswer(answer);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const votes = [...counts.values()].sort((a, b) => b - a);
  const top = votes[0] ?? 0;
  const second = votes[1] ?? 0;

  // 首位が 2 票未満なら、そもそも多数決が成立していない
  if (top < 2) return false;

  // 残り全部が 2 位（または新しい答え）へ入っても首位に届かないなら確定。
  // 同数で並ぶと最速採用の比較が要り、その相手がまだ届いていないため待つ。
  return top > second + pending;
}

/** 合議の経緯を 1 行で説明する。画面に出す */
export function describeConsensus(consensus: Consensus): string {
  switch (consensus.reason) {
    case 'majority':
      return `${consensus.supporters.length}/${consensus.participants} が同じ回答`;
    case 'fastest':
      return consensus.participants === 1
        ? '回答できたのは 1 モデルのみ'
        : `${consensus.participants} モデルが相違、最速を採用`;
    case 'none':
      return '回答できたモデルなし';
  }
}
