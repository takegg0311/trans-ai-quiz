"""OpenAI Decisions API。

内部の標準形式（TypeSafe 形の questions / answers）を OpenAI の形へ変換し、
応答を標準形式へ戻す。router の値の取り出しは変えない。
"""

from __future__ import annotations

from typing import Any

import httpx

from .config import PROVIDERS, REQUEST_TIMEOUT_SECONDS
from .errors import JudgeError, from_status

_SPEC = PROVIDERS["openai"]


async def evaluate(
    text: str,
    questions: dict[str, dict[str, object]],
    *,
    model: str,
    api_key: str,
) -> dict[str, object]:
    """text を questions で評価し、標準形式の answers を返す。"""
    payload = {
        "model": model,
        "input": text,
        "questions": [_to_question(name, question) for name, question in questions.items()],
    }

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(
                _SPEC.api_url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
            )
    except httpx.TimeoutException as error:
        raise JudgeError(
            "timeout", f"応答がありませんでした（{REQUEST_TIMEOUT_SECONDS} 秒）"
        ) from error
    except httpx.HTTPError as error:
        raise JudgeError("network", f"接続できませんでした: {error}") from error

    if response.status_code != 200:
        raise from_status(response, _SPEC.label)

    try:
        body = response.json()
    except ValueError as error:
        raise JudgeError("unknown", "応答を JSON として解釈できませんでした") from error

    answers = body.get("answers") if isinstance(body, dict) else None
    if not isinstance(answers, list):
        raise JudgeError("unknown", "応答に answers が含まれていませんでした")

    return _normalize_answers(answers)


def _to_question(name: str, question: dict[str, object]) -> dict[str, object]:
    """標準形式の 1 問を OpenAI Decisions の形へ写す。"""
    qtype = question.get("type")
    instructions = str(question.get("instructions") or "")

    if qtype == "noul":
        # predicate には criteria 欄が無いので、真偽の説明を instructions へ書き足す
        criteria = question.get("criteria")
        if isinstance(criteria, dict):
            true_text = str(criteria.get("true") or "")
            false_text = str(criteria.get("false") or "")
            instructions = (
                f"{instructions}\n真とは: {true_text}\n偽とは: {false_text}"
            )
        return {
            "type": "predicate",
            "name": name,
            "instructions": instructions,
        }

    if qtype == "score":
        criteria = question.get("criteria")
        levels: list[dict[str, str]] = []
        if isinstance(criteria, list):
            levels = [{"label": str(item)} for item in criteria]
        return {
            "type": "score",
            "name": name,
            "instructions": instructions,
            "levels": levels,
        }

    raise JudgeError("bad_request", f"未対応の質問 type です: {qtype}")


def _normalize_answers(answers: list[Any]) -> dict[str, object]:
    """OpenAI の answers 配列を標準形式の map へ戻す。

    refusal は欠測としてキーを作らない（router が None にする）。
    """
    normalized: dict[str, object] = {}
    for item in answers:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or name == "":
            continue

        item_type = item.get("type")
        if item_type == "refusal":
            continue

        if item_type == "predicate":
            probability = item.get("probability")
            if isinstance(probability, (int, float)):
                normalized[name] = {"noul": float(probability)}
            continue

        if item_type == "score":
            entry: dict[str, object] = {}
            score = item.get("score")
            if isinstance(score, (int, float)):
                entry["score"] = float(score)
            confidence = item.get("confidence")
            if isinstance(confidence, (int, float)):
                entry["confidence"] = float(confidence)
            if entry:
                normalized[name] = entry
            continue

    return normalized
