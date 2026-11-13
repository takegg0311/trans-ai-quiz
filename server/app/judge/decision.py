"""押下判定。Jev の観測値から「今押すか」を決める。

サーバの /judge はこれを呼ばない。観測値だけを返し、判断は呼び出し側に置く
方針のままとする。ここに置くのは、計測スクリプトと jev-poc が同じ規則を
共有するため。オフラインで測った成績と実機の挙動がズレると、閾値を調整する
根拠が失われる。

規則は 2026-09-22 の計測（11 問 380 点 × 3 variant）で決めた。
"""

from __future__ import annotations

from dataclasses import dataclass

#: 単独で押せる buzz。これを超えたら asking を見ない。
#
# 計測では、転換前の危険点の buzz は 0.72〜0.86 に収まる一方、
# 非パラレル問題の確信点は 0.90 超まで伸びた。強い確信は
# パラレル問題では観測されていないため、ゲートを課さない。
BUZZ_STRONG = 0.90

#: asking を確認した上で押せる buzz。
BUZZ_WEAK = 0.70

#: 問いが始まったとみなす asking。
#
# 0.50 では、パラレル問題の「地球で最も高い山」（asking=0.55）
# 「日本で最も高い山」（0.51）「…西を守っているの」（0.58）を通してしまう。
# いずれも述語の直前で、それ自体が問いとして完結して見える位置である。
#
# 0.60 へ上げると、この 3 件はすべて止まる。非パラレル問題 5 問の押下位置は
# 0.50 のときと 1 字も変わらないため、この引き上げに費用は無い。
# 影響を受けるのはパラレル問題だけで、そこは押さない方が正しい。
ASKING_MIN = 0.60

#: パラレル問題の危険区間（文字数）。ここを超えたら asking を見ない。
#
# questions.csv の全パラレル問題 6 問で「ですが」の位置は 12〜26 字であり、
# 26 字より後に転換が来る問題は 1 問も無かった。長い前置きの後に転換を置くと
# 問題文全体が長くなりすぎるためで、出題形式に由来する構造的な性質である。
#
# 26 字に少しの余裕を足して 30 字とする。これを超えた区間では asking を
# 課さないことで、確定点が後半にある問題（計測では「シカト」「ジョージ・
# マロリー」）が本来の位置で押せるようになる。
PARALLEL_RISK_CHARS = 30

#: 単刀直入な問いの合図。これが出たらパラレルの危険は無いとみなす。
#
# 「ずばり」を挟む問題は転換せずそのまま答えを問う。現在の questions.csv には
# 該当が無く効果を実測できていないが、規則としては単純で副作用も無い。
DIRECT_MARKERS = ("ずばり",)


@dataclass(frozen=True)
class Judgement:
    """押下判定の結果。押さない場合も理由を残す。"""

    press: bool
    #: 押した／見送った理由。画面とログに出す
    reason: str


def in_parallel_risk(partial_text: str) -> bool:
    """パラレル問題の危険区間にいるか。

    危険区間を抜けていれば asking を確認する必要が無い。
    """
    if any(marker in partial_text for marker in DIRECT_MARKERS):
        return False
    return len(partial_text) <= PARALLEL_RISK_CHARS


def decide(
    partial_text: str,
    buzz: float | None,
    asking: float | None,
) -> Judgement:
    """今押すかを決める。

    buzz が欠測なら押さない。観測が得られなかった時点で押すと、
    値が無いことと 0 であることを取り違えることになる。
    """
    if buzz is None:
        return Judgement(False, "buzz が取得できていない")

    if buzz >= BUZZ_STRONG:
        return Judgement(True, f"buzz {buzz:.2f} が単独閾値 {BUZZ_STRONG} を超えた")

    if buzz < BUZZ_WEAK:
        return Judgement(False, f"buzz {buzz:.2f} が {BUZZ_WEAK} 未満")

    if not in_parallel_risk(partial_text):
        return Judgement(
            True,
            f"buzz {buzz:.2f} / {len(partial_text)} 字で危険区間を抜けている",
        )

    if asking is None:
        return Judgement(False, "危険区間で asking が取得できていない")

    if asking < ASKING_MIN:
        return Judgement(
            False,
            f"buzz {buzz:.2f} だが asking {asking:.2f} が低く、まだ問いに入っていない",
        )

    return Judgement(True, f"buzz {buzz:.2f} / asking {asking:.2f} がそろった")
