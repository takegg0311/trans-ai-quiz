"""Jev 判定の HTTP エンドポイント。

/judge は読み上げ中に連続で呼ばれる。問題文の全文と正解は受け取らない。
jev-poc 側が保持したままにし、渡すのはその時点で画面に出ていた文字列だけとする
（llm/router.py の /predict と同じ原則）。

閾値の判断はここでは行わない。観測値をそのまま返し、押すかどうかは
呼び出し側が決める。閾値は実測で調整するものであり、サーバへ焼き込むと
フロントから動かせなくなるため。
"""

from __future__ import annotations

import time

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .client import JevError, evaluate
from .config import ENV_KEY, api_key, model
from .questions import ACTIVE_QUESTIONS, NARROWED_LEVELS

router = APIRouter(prefix="/api/jev", tags=["jev"])


class JudgeRequest(BaseModel):
    #: 読み上げ済みの問題文。文の途中で切れていてよい
    partial_text: str = Field(min_length=1)


@router.get("/health")
async def health() -> dict[str, object]:
    """Jev が使える状態かを返す。

    jev-poc はこれを起動時に叩き、使えなければ自動早押しを無効にして
    手動のみで動かす（凍結 poc/ の LLM 枠が縮退するのと同じ方針）。
    """
    available = api_key() is not None
    view: dict[str, object] = {
        "available": available,
        "model": model(),
        #: narrowed の score は 0〜1 ではなく 0〜(段階数-1)。
        #  値域を取り違えないよう、段階数を明示して返す。
        "narrowed_levels": NARROWED_LEVELS,
    }
    if not available:
        view["reason"] = f"{ENV_KEY} が設定されていません"
    return view


@router.post("/judge")
async def judge(request: JudgeRequest) -> dict[str, object]:
    """読み上げ済みの問題文を評価し、各質問の値を返す。

    HTTP ステータスは失敗しても 200 のままとする。読み上げ中は次の文字で
    再送されるため、1 回の失敗はリクエスト自体の失敗ではなく、その時点の
    観測が得られなかったという情報にすぎない。区別は ok と error_kind で行う。
    """
    started = time.perf_counter()

    try:
        answers = await evaluate(request.partial_text, ACTIVE_QUESTIONS)
    except JevError as error:
        return {
            "ok": False,
            "error_kind": error.kind,
            "error": error.message,
            "elapsed_ms": _elapsed_ms(started),
        }
    except Exception as error:  # noqa: BLE001 - 観測が得られなかった旨として返す
        return {
            "ok": False,
            "error_kind": "unknown",
            "error": str(error) or type(error).__name__,
            "elapsed_ms": _elapsed_ms(started),
        }

    return {
        "ok": True,
        "buzz": _noul(answers, "buzz"),
        "parallel": _noul(answers, "parallel"),
        "asking": _noul(answers, "asking"),
        "narrowed": _score(answers, "narrowed"),
        "narrowed_confidence": _confidence(answers, "narrowed"),
        "elapsed_ms": _elapsed_ms(started),
    }


def _noul(answers: dict[str, object], key: str) -> float | None:
    """noul の値（0〜1 の yes 確率）を取り出す。

    noul には confidence が無い。分布が yes/no の 2 つしかなく、
    noul の値そのものが分布を完全に表すため。
    """
    return _number(answers.get(key), "noul")


def _score(answers: dict[str, object], key: str) -> float | None:
    """score の値を取り出す。値域は 0〜(段階数-1) であって 0〜1 ではない。"""
    return _number(answers.get(key), "score")


def _confidence(answers: dict[str, object], key: str) -> float | None:
    """score の confidence（分布の集中度、0〜1）を取り出す。"""
    return _number(answers.get(key), "confidence")


def _number(answer: object, field: str) -> float | None:
    """応答から数値を 1 つ取り出す。欠けていれば None を返す。

    質問を足したのに応答へ現れない、といった食い違いを握り潰さずに
    「値が無かった」として表に出すため、既定値で埋めない。
    """
    if not isinstance(answer, dict):
        return None
    value = answer.get(field)
    return float(value) if isinstance(value, (int, float)) else None


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)
