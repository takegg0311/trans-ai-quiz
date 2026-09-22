"""確定曲線の計測。Phase 4 の閾値をここで決める。

questions.csv の問題文を先頭から 1 文字ずつ伸ばしながら Jev へ投げ、
buzz / parallel / narrowed の推移を CSV へ落とす。

    uv run python scripts/measure_buzz_curve.py --limit 5

出力（既定 logs/buzz_curve.csv）は 1 問 × 1 文字数 = 1 行。
これを集計して「どの閾値なら、どれだけ早く・どれだけ正確に押せるか」を見る。

閾値を先に決めてから UI を作ると、実測に合わない値が焼き込まれる。
順序を逆にしないためのスクリプトである。

注意: 1 問あたり (文字数 / step) 回 API を叩く。--limit と --step で加減すること。
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import sys
from dataclasses import dataclass
from pathlib import Path

# server/ を import パスへ通す（スクリプトを直接実行するため）
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.jev.client import JevError, evaluate  # noqa: E402
from app.jev.config import api_key  # noqa: E402
from app.jev.questions import VARIANTS  # noqa: E402
from app.quiz import QUIZ_DATA_DIR, QuizDataError, load_questions  # noqa: E402

DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "logs" / "buzz_curve.csv"

COLUMNS = (
    "variant",
    "question_id",
    "answer",
    "total_chars",
    "chars",
    "partial_text",
    "buzz",
    "parallel",
    "asking",
    "narrowed",
    "narrowed_confidence",
    "elapsed_ms",
    "error",
)


@dataclass
class Sample:
    """1 問 × 1 文字数ぶんの観測。"""

    variant: str
    question_id: str
    answer: str
    total_chars: int
    chars: int
    partial_text: str
    buzz: float | None = None
    parallel: float | None = None
    asking: float | None = None
    narrowed: float | None = None
    narrowed_confidence: float | None = None
    elapsed_ms: int = 0
    error: str = ""

    def as_row(self) -> dict[str, object]:
        return {
            "variant": self.variant,
            "question_id": self.question_id,
            "answer": self.answer,
            "total_chars": self.total_chars,
            "chars": self.chars,
            "partial_text": self.partial_text,
            "buzz": _fmt(self.buzz),
            "parallel": _fmt(self.parallel),
            "asking": _fmt(self.asking),
            "narrowed": _fmt(self.narrowed),
            "narrowed_confidence": _fmt(self.narrowed_confidence),
            "elapsed_ms": self.elapsed_ms,
            "error": self.error,
        }


def _fmt(value: float | None) -> str:
    """CSV へ書く数値。欠測は空欄にし、0 と区別できるようにする。"""
    return "" if value is None else f"{value:.4f}"


def _number(answer: object, field: str) -> float | None:
    if not isinstance(answer, dict):
        return None
    value = answer.get(field)
    return float(value) if isinstance(value, (int, float)) else None


async def _measure_one(
    variant: str,
    questions: dict[str, dict[str, object]],
    question_id: str,
    answer: str,
    text: str,
    step: int,
) -> list[Sample]:
    """1 問を 1 文字ずつ伸ばしながら評価する。

    逐次に投げるのは、読み上げの進行を模すためではなく、レート制限を避けるため。
    確定曲線の形は投げる順序に依らないので、並列化しても結果は変わらない。
    """
    import time

    chars = list(text)
    total = len(chars)
    samples: list[Sample] = []

    for end in range(step, total + 1, step):
        partial = "".join(chars[:end])
        sample = Sample(
            variant=variant,
            question_id=question_id,
            answer=answer,
            total_chars=total,
            chars=end,
            partial_text=partial,
        )

        started = time.perf_counter()
        try:
            answers = await evaluate(partial, questions)
        except JevError as error:
            sample.error = f"{error.kind}: {error.message}"
        else:
            sample.buzz = _number(answers.get("buzz"), "noul")
            sample.parallel = _number(answers.get("parallel"), "noul")
            # asking は v3 以降にのみ存在する。無ければ欠測のまま。
            sample.asking = _number(answers.get("asking"), "noul")
            sample.narrowed = _number(answers.get("narrowed"), "score")
            sample.narrowed_confidence = _number(answers.get("narrowed"), "confidence")
        sample.elapsed_ms = int((time.perf_counter() - started) * 1000)

        samples.append(sample)
        _print_progress(sample)

    return samples


def _print_progress(sample: Sample) -> None:
    """進捗を 1 行ずつ出す。長時間走るため、黙って進まないようにする。"""
    if sample.error:
        print(f"  {sample.chars:3d}/{sample.total_chars}  ERROR {sample.error}")
        return
    print(
        f"  {sample.chars:3d}/{sample.total_chars}  "
        f"buzz={_fmt(sample.buzz)}  parallel={_fmt(sample.parallel)}  "
        f"asking={_fmt(sample.asking)}  narrowed={_fmt(sample.narrowed)}  "
        f"{sample.elapsed_ms}ms"
    )


async def _run(
    limit: int | None,
    step: int,
    output: Path,
    variant: str,
    only_parallel: bool,
) -> int:
    if api_key() is None:
        print("TYPESAFE_API_KEY が設定されていません（server/.env）", file=sys.stderr)
        return 1

    try:
        questions = load_questions()
    except QuizDataError as error:
        print(f"問題データを読み込めませんでした: {error}", file=sys.stderr)
        return 1

    # パラレル問題だけを測りたい場合に絞る。初回計測では 1 問も含まれず、
    # parallel の誤検出に気づくのが遅れた。
    if only_parallel:
        questions = [q for q in questions if "ですが" in q.text]

    if limit is not None:
        questions = questions[:limit]

    if not questions:
        print(f"問題がありません（{QUIZ_DATA_DIR}）", file=sys.stderr)
        return 1

    output.parent.mkdir(parents=True, exist_ok=True)
    all_samples: list[Sample] = []

    for index, question in enumerate(questions, start=1):
        print(f"[{index}/{len(questions)}] {question.id}  正解: {question.answers[0]}")
        samples = await _measure_one(
            variant,
            VARIANTS[variant],
            question.id,
            question.answers[0],
            question.text,
            step,
        )
        all_samples.extend(samples)

    # 追記にして、variant を変えた計測を 1 ファイルへ貯める。
    # 比較のたびに前回分が消えると、同じ問題で測り直す手間がかかる。
    exists = output.is_file()
    with output.open("a" if exists else "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        if not exists:
            writer.writeheader()
        for sample in all_samples:
            writer.writerow(sample.as_row())

    print()
    print(f"{len(all_samples)} 件を書き出しました: {output}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--limit", type=int, default=None, help="評価する問題数（既定: 全問）"
    )
    parser.add_argument(
        "--step",
        type=int,
        default=1,
        help="何文字ごとに評価するか（既定: 1。API 呼び出しを減らすなら増やす）",
    )
    parser.add_argument(
        "--variant",
        choices=sorted(VARIANTS),
        default="v3",
        help="使う質問定義（既定: v3。/api/jev/judge と同じもの）",
    )
    parser.add_argument(
        "--only-parallel",
        action="store_true",
        help="「ですが」を含むパラレル問題だけを測る",
    )
    parser.add_argument(
        "--output", type=Path, default=DEFAULT_OUTPUT, help=f"出力先（既定: {DEFAULT_OUTPUT}）"
    )
    args = parser.parse_args()

    if args.step < 1:
        parser.error("--step は 1 以上である必要があります")

    return asyncio.run(
        _run(args.limit, args.step, args.output, args.variant, args.only_parallel)
    )


if __name__ == "__main__":
    raise SystemExit(main())
