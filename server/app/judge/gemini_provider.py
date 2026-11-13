"""Gemini Decision 1 API。

内部の標準形式を Gemini の形へ変換し、応答を標準形式へ戻す。
安全性ブロックは HTTP 400 で返るため、既存どおり bad_request に分類する。
"""

from __future__ import annotations

from typing import Any

import httpx

from .config import PROVIDERS, REQUEST_TIMEOUT_SECONDS
from .errors import JudgeError, from_status

_SPEC = PROVIDERS["gemini"]


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
        "questions": {
            name: _to_question(question) for name, question in questions.items()
        },
    }

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(
                _SPEC.api_url,
                json=payload,
                headers={
                    "x-goog-api-key": api_key,
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
    if not isinstance(answers, dict):
        raise JudgeError("unknown", "応答に answers が含まれていませんでした")

    return _normalize_answers(answers)


def _to_question(question: dict[str, object]) -> dict[str, object]:
    """標準形式の 1 問を Gemini Decisions の形へ写す。"""
    qtype = question.get("type")
    instructions = str(question.get("instructions") or "")

    if qtype == "noul":
        criteria = question.get("criteria")
        true_description = ""
        false_description = ""
        if isinstance(criteria, dict):
            true_description = str(criteria.get("true") or "")
            false_description = str(criteria.get("false") or "")
        return {
            "type": "noul",
            "instructions": instructions,
            "criteria": {
                "true_description": true_description,
                "false_description": false_description,
            },
        }

    if qtype == "score":
        criteria = question.get("criteria")
        levels: list[str] = []
        if isinstance(criteria, list):
            levels = [str(item) for item in criteria]
        return {
            "type": "score",
            "instructions": instructions,
            "criteria": levels,
        }

    raise JudgeError("bad_request", f"未対応の質問 type です: {qtype}")


def _normalize_answers(answers: dict[str, Any]) -> dict[str, object]:
    """Gemini の answers map を標準形式へ揃える。

    noul / score / confidence はそのまま取り出す。余分な legend 等は落とす。
    """
    normalized: dict[str, object] = {}
    for name, item in answers.items():
        if not isinstance(item, dict):
            continue

        item_type = item.get("type")
        if item_type == "noul":
            noul = item.get("noul")
            if isinstance(noul, (int, float)):
                normalized[name] = {"noul": float(noul)}
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
