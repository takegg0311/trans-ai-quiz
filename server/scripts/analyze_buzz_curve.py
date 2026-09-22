"""確定曲線から閾値ごとの成績を出し、質問定義（variant）を比較する。

measure_buzz_curve.py の出力を読み、variant ごとに次を見る。

  - 閾値の組み合わせごとの押下率と押下位置
  - buzz の上限（全文を読み切った時点の値）
  - パラレル問題での parallel の効き（前振り部と転換後の差）

    uv run python scripts/analyze_buzz_curve.py

このスクリプトは API を叩かない。計測済みの CSV だけを読む。
閾値を変えて試すたびに課金される形にしないため。
"""

from __future__ import annotations

import argparse
import csv
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path

# server/ を import パスへ通す（スクリプトを直接実行するため）
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.jev.decision import decide  # noqa: E402

DEFAULT_INPUT = Path(__file__).resolve().parents[1] / "logs" / "buzz_curve.csv"

#: 試す buzz の閾値。
BUZZ_THRESHOLDS = (0.50, 0.60, 0.70, 0.80, 0.85, 0.90)

#: 試す parallel の上限。これを超えたら前振り中とみなして押さない。
#  1.00 はゲート無効（比較の基準）。
PARALLEL_BLOCKS = (1.00, 0.50, 0.35)

#: 試す asking の下限。これを下回る間は「まだ問いが始まっていない」として押さない。
#  0.00 はゲート無効（比較の基準）。
ASKING_GATES = (0.00, 0.30, 0.50, 0.70)

#: パラレル問題の転換語。前振り部と転換後を分ける目印に使う。
PIVOT = "ですが"


@dataclass
class Row:
    variant: str
    question_id: str
    answer: str
    total_chars: int
    chars: int
    partial_text: str
    buzz: float | None
    parallel: float | None
    asking: float | None


def _to_float(value: str) -> float | None:
    """空欄は欠測として None にする。0 と区別するため。"""
    if value.strip() == "":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _load(path: Path) -> list[Row]:
    with path.open(encoding="utf-8", newline="") as handle:
        return [
            Row(
                # variant 列が無い古い計測は v1 とみなす
                variant=raw.get("variant") or "v1",
                question_id=raw["question_id"],
                answer=raw["answer"],
                total_chars=int(raw["total_chars"]),
                chars=int(raw["chars"]),
                partial_text=raw["partial_text"],
                buzz=_to_float(raw["buzz"]),
                parallel=_to_float(raw["parallel"]),
                asking=_to_float(raw.get("asking", "")),
            )
            for raw in csv.DictReader(handle)
        ]


def _by_question(rows: list[Row]) -> dict[str, list[Row]]:
    grouped: dict[str, list[Row]] = {}
    for row in rows:
        grouped.setdefault(row.question_id, []).append(row)
    for question_rows in grouped.values():
        question_rows.sort(key=lambda r: r.chars)
    return grouped


def _first_press(
    rows: list[Row],
    buzz_min: float,
    parallel_max: float,
    asking_min: float = 0.0,
) -> Row | None:
    """その閾値で最初に押す位置を返す。最後まで押さなければ None。"""
    for row in rows:
        if row.buzz is None or row.buzz < buzz_min:
            continue
        # parallel が欠測なら判断材料が無い。押さない側へ倒す。
        if parallel_max < 1.0 and (row.parallel is None or row.parallel > parallel_max):
            continue
        # asking も同様。まだ問いが始まっていない間は押さない。
        if asking_min > 0.0 and (row.asking is None or row.asking < asking_min):
            continue
        return row
    return None


def _ceiling(by_question: dict[str, list[Row]]) -> None:
    """buzz の上限を見る。

    全文を読み切った時点は答えが自明であり、そこが buzz の実質的な上限になる。
    これが 1.0 に届かない場合、それより高い閾値は「全文読んでも押さない」を意味する。
    """
    print("  buzz の上限（全文を読み切った時点の値）")
    finals = []
    for question_id, rows in sorted(by_question.items()):
        final = rows[-1].buzz
        if final is None:
            continue
        finals.append(final)
        peak = max((r.buzz for r in rows if r.buzz is not None), default=0.0)
        print(f"    {question_id}  読み切り {final:.2f}   最大 {peak:.2f}")
    if finals:
        print(f"    平均 {statistics.mean(finals):.3f}   最小 {min(finals):.2f}")
    print()


def _table(by_question: dict[str, list[Row]]) -> None:
    print("  buzz>= parallel<=   押下率   平均押下位置   最早   最遅")
    print("  " + "-" * 58)
    for parallel_max in PARALLEL_BLOCKS:
        for buzz_min in BUZZ_THRESHOLDS:
            presses = [
                _first_press(rows, buzz_min, parallel_max)
                for rows in by_question.values()
            ]
            pressed = [p for p in presses if p is not None]

            if not pressed:
                print(f"  {buzz_min:5.2f}  {parallel_max:8.2f}     0.0%          -      -      -")
                continue

            ratios = [p.chars / p.total_chars for p in pressed]
            print(
                f"  {buzz_min:5.2f}  {parallel_max:8.2f}   "
                f"{len(pressed) / len(by_question) * 100:5.1f}%  "
                f"{statistics.mean(ratios) * 100:9.1f}%  "
                f"{min(ratios) * 100:5.1f}%  {max(ratios) * 100:5.1f}%"
            )
        print()


def _rule_result(by_question: dict[str, list[Row]]) -> None:
    """実装された押下規則（app.jev.decision）での成績。

    表の総当たりと違い、これが jev-poc で実際に起きることである。
    スクリプトと UI が同じ関数を使うことで、オフラインで測った成績と
    実機の挙動がズレないようにしている。
    """
    has_asking = any(
        r.asking is not None for rows in by_question.values() for r in rows
    )
    if not has_asking:
        return

    print("  実装された押下規則（app.jev.decision.decide）")
    ratios = []
    wrong = 0
    for question_id, rows in sorted(by_question.items()):
        pressed = None
        for row in rows:
            if decide(row.partial_text, row.buzz, row.asking).press:
                pressed = row
                break

        full = rows[-1].partial_text
        marker = full.find(PIVOT)
        tag = "P" if marker >= 0 else " "

        if pressed is None:
            print(f"    {tag} {question_id:14s} 押さず")
            continue

        ratios.append(pressed.chars / pressed.total_chars)
        # パラレル問題で転換前に押していれば誤答
        bad = marker >= 0 and pressed.chars <= marker
        if bad:
            wrong += 1
        print(
            f"    {tag} {question_id:14s} {pressed.chars:3d}字 "
            f"({pressed.chars / pressed.total_chars * 100:4.1f}%)"
            f"{'  ← 転換前！誤答' if bad else ''}"
        )

    if ratios:
        print(
            f"    押下 {len(ratios)}/{len(by_question)} 問  "
            f"平均位置 {statistics.mean(ratios) * 100:.1f}%  "
            f"転換前の誤押し {wrong} 件"
        )
    print()


def _asking_table(by_question: dict[str, list[Row]]) -> None:
    """asking ゲートの効きを見る。asking を持つ variant でのみ意味がある。"""
    has_asking = any(
        r.asking is not None for rows in by_question.values() for r in rows
    )
    if not has_asking:
        return

    print("  asking ゲート（buzz>=0.70 固定、parallel ゲートなし）")
    print("  asking>=   押下率   平均押下位置   最早   最遅")
    print("  " + "-" * 50)
    for asking_min in ASKING_GATES:
        presses = [
            _first_press(rows, 0.70, 1.00, asking_min)
            for rows in by_question.values()
        ]
        pressed = [p for p in presses if p is not None]
        if not pressed:
            print(f"  {asking_min:8.2f}     0.0%          -      -      -")
            continue
        ratios = [p.chars / p.total_chars for p in pressed]
        print(
            f"  {asking_min:8.2f}   "
            f"{len(pressed) / len(by_question) * 100:5.1f}%  "
            f"{statistics.mean(ratios) * 100:9.1f}%  "
            f"{min(ratios) * 100:5.1f}%  {max(ratios) * 100:5.1f}%"
        )
    print()


def _danger_check(by_question: dict[str, list[Row]]) -> None:
    """パラレル問題の転換前に、誤って押せてしまう点を数える。

    「ですが」より前で buzz が閾値を超えた観測点が、防ぎたい誤押しである。
    各ゲートがそこを止められているかを見る。
    """
    has_asking = any(
        r.asking is not None for rows in by_question.values() for r in rows
    )

    print("  転換前の誤押し（「ですが」より前で buzz>=0.70 に達した点）")
    total_danger = 0
    blocked_by_parallel = 0
    blocked_by_asking = 0

    for question_id, rows in sorted(by_question.items()):
        full = rows[-1].partial_text
        marker = full.find(PIVOT)
        if marker < 0:
            continue

        danger = [
            r for r in rows
            if r.chars <= marker and r.buzz is not None and r.buzz >= 0.70
        ]
        if not danger:
            continue

        total_danger += len(danger)
        par = sum(1 for r in danger if r.parallel is not None and r.parallel > 0.35)
        ask = sum(1 for r in danger if r.asking is not None and r.asking < 0.50)
        blocked_by_parallel += par
        blocked_by_asking += ask

        detail = f"parallel>0.35 で {par}/{len(danger)} 件を阻止"
        if has_asking:
            detail += f" / asking<0.50 で {ask}/{len(danger)} 件を阻止"
        print(f"    {question_id}  危険点 {len(danger)} 件  {detail}")

    if total_danger == 0:
        print("    転換前に buzz>=0.70 へ達した点はありません。")
        print()
        return

    print(f"    合計 危険点 {total_danger} 件")
    print(f"      parallel>0.35 ゲート: {blocked_by_parallel}/{total_danger} 件を阻止")
    if has_asking:
        print(f"      asking<0.50 ゲート:   {blocked_by_asking}/{total_danger} 件を阻止")
    print()


def _parallel_check(by_question: dict[str, list[Row]]) -> None:
    """パラレル問題で前振り部の parallel が転換後より高く出ているかを見る。

    非パラレル問題での平均も並べる。パラレルでない問題で高く出るなら、
    それは「文がまだ続くか」を拾っているだけで、検出器として働いていない。
    """
    print("  parallel の効き")

    pivot_rows: list[tuple[str, float, float]] = []
    plain_means: list[float] = []

    for question_id, rows in sorted(by_question.items()):
        full = rows[-1].partial_text
        marker = full.find(PIVOT)
        values = [r.parallel for r in rows if r.parallel is not None]
        if not values:
            continue

        if marker < 0:
            plain_means.append(statistics.mean(values))
            continue

        before = [r.parallel for r in rows if r.chars <= marker and r.parallel is not None]
        after = [r.parallel for r in rows if r.chars > marker and r.parallel is not None]
        if before and after:
            pivot_rows.append(
                (question_id, statistics.mean(before), statistics.mean(after))
            )

    if pivot_rows:
        print("    パラレル問題（前振り部 → 転換後）")
        for question_id, before, after in pivot_rows:
            arrow = "○" if before > after else "×"
            print(f"      {arrow} {question_id}  {before:.3f} → {after:.3f}")
        befores = [b for _, b, _ in pivot_rows]
        print(f"      前振り部 平均 {statistics.mean(befores):.3f}")
    else:
        print("    パラレル問題が計測データにありません（--only-parallel で測れます）")

    if plain_means:
        print(f"    非パラレル問題 平均 {statistics.mean(plain_means):.3f}  ← 低いほどよい")
        if pivot_rows:
            befores = [b for _, b, _ in pivot_rows]
            gap = statistics.mean(befores) - statistics.mean(plain_means)
            print(f"    差（前振り部 − 非パラレル） {gap:+.3f}  ← 大きいほど検出器として有効")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    args = parser.parse_args()

    if not args.input.is_file():
        print(f"計測データがありません: {args.input}", file=sys.stderr)
        print("先に measure_buzz_curve.py を実行してください。", file=sys.stderr)
        return 1

    rows = _load(args.input)
    if not rows:
        print("計測データが空です。", file=sys.stderr)
        return 1

    variants: dict[str, list[Row]] = {}
    for row in rows:
        variants.setdefault(row.variant, []).append(row)

    for variant, variant_rows in sorted(variants.items()):
        by_question = _by_question(variant_rows)
        print(f"=== {variant}   問題数 {len(by_question)}   観測点 {len(variant_rows)} ===")
        print()
        _ceiling(by_question)
        _table(by_question)
        _rule_result(by_question)
        _asking_table(by_question)
        _danger_check(by_question)
        _parallel_check(by_question)

    print("押下位置は問題文全体に対する割合。小さいほど早く押せている。")
    print("押下率が 100% を割る閾値は、押せないまま読み切る問題があることを意味する。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
