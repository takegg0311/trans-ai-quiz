"""確定曲線から閾値ごとの成績を出す。

measure_buzz_curve.py の出力を読み、閾値の組み合わせごとに
「どれだけ早く押せたか」と「押した時点で正答できたか」を集計する。

    uv run python scripts/analyze_buzz_curve.py

正誤は「押した時点の問題文に正解が含まれているか」では測れない
（含まれていれば答えは自明であり、そこは確定ポイントより後である）。
ここでは代理指標として、押下位置と問題文全体の長さの比を見る。
実際の正誤は jev-poc で人が確かめる。

このスクリプトは API を叩かない。計測済みの CSV だけを読む。
"""

from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass
from pathlib import Path

DEFAULT_INPUT = Path(__file__).resolve().parents[1] / "logs" / "buzz_curve.csv"

#: 試す buzz の閾値。
BUZZ_THRESHOLDS = (0.60, 0.70, 0.80, 0.85, 0.90, 0.95)

#: 試す parallel の上限。これを超えたら前振り中とみなして押さない。
PARALLEL_BLOCKS = (1.00, 0.50, 0.35, 0.20)


@dataclass
class Row:
    question_id: str
    answer: str
    total_chars: int
    chars: int
    partial_text: str
    buzz: float | None
    parallel: float | None


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
                question_id=raw["question_id"],
                answer=raw["answer"],
                total_chars=int(raw["total_chars"]),
                chars=int(raw["chars"]),
                partial_text=raw["partial_text"],
                buzz=_to_float(raw["buzz"]),
                parallel=_to_float(raw["parallel"]),
            )
            for raw in csv.DictReader(handle)
        ]


def _first_press(rows: list[Row], buzz_min: float, parallel_max: float) -> Row | None:
    """その閾値で最初に押す位置を返す。最後まで押さなければ None。"""
    for row in sorted(rows, key=lambda r: r.chars):
        if row.buzz is None:
            continue
        if row.buzz < buzz_min:
            continue
        # parallel が欠測なら判断材料が無い。押さない側へ倒す。
        if parallel_max < 1.0 and (row.parallel is None or row.parallel > parallel_max):
            continue
        return row
    return None


def _report(rows: list[Row]) -> None:
    by_question: dict[str, list[Row]] = {}
    for row in rows:
        by_question.setdefault(row.question_id, []).append(row)

    print(f"問題数: {len(by_question)}   観測点: {len(rows)}")
    print()
    print("buzz>= parallel<=   押下率   平均押下位置   最早   最遅")
    print("-" * 60)

    for parallel_max in PARALLEL_BLOCKS:
        for buzz_min in BUZZ_THRESHOLDS:
            presses = [
                _first_press(question_rows, buzz_min, parallel_max)
                for question_rows in by_question.values()
            ]
            pressed = [p for p in presses if p is not None]

            if not pressed:
                print(f"{buzz_min:5.2f}  {parallel_max:8.2f}     0.0%          -      -      -")
                continue

            ratios = [p.chars / p.total_chars for p in pressed]
            print(
                f"{buzz_min:5.2f}  {parallel_max:8.2f}   "
                f"{len(pressed) / len(by_question) * 100:5.1f}%  "
                f"{sum(ratios) / len(ratios) * 100:9.1f}%  "
                f"{min(ratios) * 100:5.1f}%  {max(ratios) * 100:5.1f}%"
            )
        print()

    print("押下位置は問題文全体に対する割合。小さいほど早く押せている。")
    print("押下率が 100% を割る閾値は、押せないまま読み切る問題があることを意味する。")


def _parallel_check(rows: list[Row]) -> None:
    """パラレル問題で前振り部分の parallel が高く出ているかを見る。

    完了条件の「前振り部分の parallel が後半より高く出る」を確かめるため。
    """
    print()
    print("=== パラレル問題の検出 ===")

    by_question: dict[str, list[Row]] = {}
    for row in rows:
        by_question.setdefault(row.question_id, []).append(row)

    found = False
    for question_id, question_rows in sorted(by_question.items()):
        ordered = sorted(question_rows, key=lambda r: r.chars)
        full = ordered[-1].partial_text
        marker = full.find("ですが")
        if marker < 0:
            continue

        found = True
        before = [r.parallel for r in ordered if r.chars <= marker and r.parallel is not None]
        after = [r.parallel for r in ordered if r.chars > marker and r.parallel is not None]
        if not before or not after:
            continue

        print(
            f"{question_id}  前振り部 平均 {sum(before) / len(before):.3f}  "
            f"転換後 平均 {sum(after) / len(after):.3f}"
        )

    if not found:
        print("「ですが」を含む問題が計測データにありません。")


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

    _report(rows)
    _parallel_check(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
