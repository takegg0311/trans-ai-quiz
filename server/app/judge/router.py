"""判定の HTTP エンドポイント。

/judge は読み上げ中に連続で呼ばれる。問題文の全文と正解は受け取らない。
呼び出し側が保持したままにし、渡すのはその時点で画面に出ていた文字列だけとする
（llm/router.py の /predict と同じ原則）。

閾値の判断はここでは行わない。観測値をそのまま返し、押すかどうかは
呼び出し側が決める。
"""

from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .client import evaluate
from .config import (
    PROVIDERS,
    PROVIDER_IDS,
    ProviderId,
    api_key,
    configured_provider_id,
    configured_provider_raw,
    model_for,
    reading_ended_delay_ms,
)
from .errors import JudgeError
from .questions import ACTIVE_QUESTIONS, NARROWED_LEVELS

router = APIRouter(prefix="/api/judge", tags=["judge"])


class JudgeRequest(BaseModel):
    #: 読み上げ済みの問題文。文の途中で切れていてよい
    partial_text: str = Field(min_length=1)
    #: 省略すれば JUDGE_PROVIDER の provider を使う。jev-poc は枠ごとに指定する
    provider: Literal["typesafe", "openai", "gemini"] | None = None


@router.get("/health")
async def health() -> dict[str, object]:
    """判定が使える状態かを返す。

    トップレベルの available / model / reason は既定の provider の値。
    providers は 3 社分を常に返す（JUDGE_PROVIDER が不明でも）。
    """
    providers = [_provider_view(provider_id) for provider_id in PROVIDER_IDS]
    default_id = configured_provider_id()
    raw = configured_provider_raw()

    if default_id is None:
        return {
            "available": False,
            "provider": raw,
            "model": "",
            "reason": f"JUDGE_PROVIDER の値が不正です: {raw}",
            "narrowed_levels": NARROWED_LEVELS,
            "reading_ended_delay_ms": reading_ended_delay_ms(),
            "providers": providers,
        }

    default_view = _provider_view(default_id)
    view: dict[str, object] = {
        "available": default_view["available"],
        "provider": default_id,
        "model": default_view["model"],
        "narrowed_levels": NARROWED_LEVELS,
        "reading_ended_delay_ms": reading_ended_delay_ms(),
        "providers": providers,
    }
    if "reason" in default_view:
        view["reason"] = default_view["reason"]
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
        answers = await evaluate(
            request.partial_text,
            ACTIVE_QUESTIONS,
            provider=request.provider,
        )
    except JudgeError as error:
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


def _provider_view(provider_id: ProviderId) -> dict[str, object]:
    spec = PROVIDERS[provider_id]
    available = api_key(spec.env_key) is not None
    view: dict[str, object] = {
        "id": spec.id,
        "label": spec.label,
        "model": model_for(provider_id),
        "available": available,
    }
    if not available:
        view["reason"] = f"{spec.env_key} が設定されていません"
    return view


def _noul(answers: dict[str, object], key: str) -> float | None:
    """noul の値（0〜1 の yes 確率）を取り出す。"""
    return _number(answers.get(key), "noul")


def _score(answers: dict[str, object], key: str) -> float | None:
    """score の値を取り出す。値域は 0〜(段階数-1) であって 0〜1 ではない。"""
    return _number(answers.get(key), "score")


def _confidence(answers: dict[str, object], key: str) -> float | None:
    """score の confidence（分布の集中度、0〜1）を取り出す。"""
    return _number(answers.get(key), "confidence")


def _number(answer: object, field: str) -> float | None:
    """応答から数値を 1 つ取り出す。欠けていれば None を返す。"""
    if not isinstance(answer, dict):
        return None
    value = answer.get(field)
    return float(value) if isinstance(value, (int, float)) else None


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)
