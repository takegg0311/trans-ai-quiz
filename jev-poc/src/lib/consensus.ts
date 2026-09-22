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
