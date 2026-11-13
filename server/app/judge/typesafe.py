"""TypeSafe（Jev）の System One API。

質問定義は内部の標準形式そのものなので変換しない。応答の answers も
そのまま返す。
"""

from __future__ import annotations

import httpx

from .config import PROVIDERS, REQUEST_TIMEOUT_SECONDS
from .errors import JudgeError, from_status

_SPEC = PROVIDERS["typesafe"]


async def evaluate(
    text: str,
    questions: dict[str, dict[str, object]],
    *,
    model: str,
    api_key: str,
) -> dict[str, object]:
    """text を questions で評価し、answers（標準形式）を返す。"""
    payload = {
        "state": text,
        "model": model,
        "questions": questions,
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
    if not isinstance(answers, dict):
        raise JudgeError("unknown", "応答に answers が含まれていませんでした")

    return answers
