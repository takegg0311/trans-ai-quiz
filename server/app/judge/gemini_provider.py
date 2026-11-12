"""Gemini Decision 1 API。

Phase 4 で質問の変換・応答の正規化を実装する。ここでは呼び出し口だけ置く。
"""

from __future__ import annotations

from .errors import JudgeError


async def evaluate(
    text: str,
    questions: dict[str, dict[str, object]],
    *,
    model: str,
    api_key: str,
) -> dict[str, object]:
    raise JudgeError("unknown", "Gemini Decision 1 アダプタは未実装です")
