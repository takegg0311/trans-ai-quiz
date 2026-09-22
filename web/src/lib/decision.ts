/**
 * 押下判定。Jev の観測値から「今押すか」を決める。
 *
 * server/app/jev/decision.py と同じ規則である。閾値は 2026-09-22 の計測
 * （11 問 380 点）で決めた。片方だけを変えると、計測スクリプトで測った成績と
 * 実機の挙動がズレて、閾値を調整する根拠が失われる。**必ず両方を直すこと。**
 *
 * サーバが判定して真偽だけを返す案も採れるが、その場合フロントは
 * なぜ押したのかを画面に出せない。観測値と規則の双方を持たせている。
 */

/** 単独で押せる buzz。これを超えたら asking を見ない */
export const BUZZ_STRONG = 0.9;

/** asking を確認した上で押せる buzz */
export const BUZZ_WEAK = 0.7;

/**
 * 問いが始まったとみなす asking。
 *
 * 0.50 では述語の直前（「日本で最も高い山」など、それ自体が問いとして
 * 完結して見える位置）を通してしまう。0.60 では非パラレル問題の押下位置が
 * 変わらず、影響を受けるのはパラレル問題だけであるため費用が無い。
 */
export const ASKING_MIN = 0.6;

/**
 * パラレル問題の危険区間（文字数）。
 *
 * questions.csv の全パラレル問題で「ですが」は 12〜26 字に現れる。
 * 長い前置きの後に転換を置くと問題文全体が長くなりすぎるためで、
 * 出題形式に由来する構造的な性質である。26 字に余裕を足して 30 字とする。
 */
export const PARALLEL_RISK_CHARS = 30;

/** 単刀直入な問いの合図。これが出たらパラレルの危険は無いとみなす */
const DIRECT_MARKERS = ['ずばり'];

export type Judgement = {
  press: boolean;
  /** 押した／見送った理由。画面とログに出す */
  reason: string;
};

/** パラレル問題の危険区間にいるか */
export function inParallelRisk(partialText: string): boolean {
  if (DIRECT_MARKERS.some((marker) => partialText.includes(marker))) return false;
  // 文字数はコードポイント単位で数える。align.ts の visibleLength と揃える
  return [...partialText].length <= PARALLEL_RISK_CHARS;
}

/**
 * 今押すかを決める。
 *
 * buzz が欠測なら押さない。観測が得られなかった時点で押すと、
 * 値が無いことと 0 であることを取り違えることになる。
 */
export function decide(
  partialText: string,
  buzz: number | null,
  asking: number | null,
): Judgement {
  if (buzz === null) {
    return { press: false, reason: 'buzz が取得できていない' };
  }

  if (buzz >= BUZZ_STRONG) {
    return { press: true, reason: `buzz ${fmt(buzz)} が単独閾値 ${BUZZ_STRONG} を超えた` };
  }

  if (buzz < BUZZ_WEAK) {
    return { press: false, reason: `buzz ${fmt(buzz)} が ${BUZZ_WEAK} 未満` };
  }

  if (!inParallelRisk(partialText)) {
    const length = [...partialText].length;
    return { press: true, reason: `buzz ${fmt(buzz)} / ${length} 字で危険区間を抜けている` };
  }

  if (asking === null) {
    return { press: false, reason: '危険区間で asking が取得できていない' };
  }

  if (asking < ASKING_MIN) {
    return {
      press: false,
      reason: `buzz ${fmt(buzz)} だが asking ${fmt(asking)} が低く、まだ問いに入っていない`,
    };
  }

  return { press: true, reason: `buzz ${fmt(buzz)} / asking ${fmt(asking)} がそろった` };
}

function fmt(value: number): string {
  return value.toFixed(2);
}
