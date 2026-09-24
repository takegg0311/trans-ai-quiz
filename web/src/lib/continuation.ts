/**
 * 予測した問題文の分割。
 *
 * LLM は押した時点の問題文から続きを補い、冒頭から末尾までの全文を返す。
 * 画面では「読み上げ済みの部分」と「予測で補った部分」を見分けられるように
 * 出したいので、ここで 2 つに分ける。
 *
 * jev-poc/src/lib/continuation.ts と同じ規則。ワークスペースが別で lib を
 * 共有していないため、それぞれに置いている。
 */

/** 予測文を分けた結果 */
export type SplitContinuation =
  /** 送った文で始まっていた。read は送った文そのもの */
  | { kind: 'split'; read: string; predicted: string }
  /** 送った文で始まっていない。分けずに全体を出す */
  | { kind: 'whole'; text: string };

/**
 * 予測文を、送った途中までの問題文（readText）と続きに分ける。
 *
 * **完全一致の前方一致だけで分ける。** 空白や記号を正規化してから比べると、
 * 分け方を誤ったときに「読まれた部分」を偽って見せることになる。
 * モデルが冒頭を書き換えた場合などは、分けずに全体を返す。
 */
export function splitContinuation(continuation: string, readText: string): SplitContinuation {
  if (readText === '' || !continuation.startsWith(readText)) {
    return { kind: 'whole', text: continuation };
  }
  return {
    kind: 'split',
    read: readText,
    predicted: continuation.slice(readText.length),
  };
}
