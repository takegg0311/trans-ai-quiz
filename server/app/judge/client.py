"""判定 API の呼び出し口。provider を選んで各アダプタへ渡す。

専用 SDK は入れず httpx で直接叩く（各アダプタ側）。リクエストもレスポンスも
JSON 1 本の単純な形で、SDK を挟むほどの構造が無いため。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from . import gemini_provider, openai_provider, typesafe
from .config import (
    PROVIDERS,
    ProviderId,
    api_key,
    configured_provider_id,
    configured_provider_raw,
    model_for,
)
from .errors import JudgeError

# 旧名の互換は置かない。呼び出し側は JudgeError を使う。
__all__ = ["JudgeError", "evaluate"]

_Evaluate = Callable[..., Awaitable[dict[str, object]]]

_ADAPTERS: dict[ProviderId, _Evaluate] = {
    "typesafe": typesafe.evaluate,
    "openai": openai_provider.evaluate,
    "gemini": gemini_provider.evaluate,
}


async def evaluate(
    text: str,
    questions: dict[str, dict[str, object]],
    *,
    provider: ProviderId | None = None,
) -> dict[str, object]:
    """問題文を questions で評価し、標準形式の answers を返す。

    provider を省略すると JUDGE_PROVIDER を使う。JUDGE_PROVIDER が不明な値なら
    外部 API を呼ばずに bad_request とする。
    """
    if provider is None:
        provider_id = configured_provider_id()
        if provider_id is None:
            raw = configured_provider_raw()
            raise JudgeError("bad_request", f"JUDGE_PROVIDER の値が不正です: {raw}")
    else:
        provider_id = provider

    spec = PROVIDERS[provider_id]
    key = api_key(spec.env_key)
    if key is None:
        raise JudgeError("auth", f"{spec.env_key} が設定されていません")

    adapter = _ADAPTERS[provider_id]
    return await adapter(text, questions, model=model_for(provider_id), api_key=key)
