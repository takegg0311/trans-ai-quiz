"""TypeSafe API の呼び出し。

専用 SDK は入れず httpx で直接叩く。リクエストは state と questions を持つ
JSON 1 本、応答は answers を持つ JSON 1 本という単純な形で、SDK を挟むほどの
構造が無いため。依存を増やさないぶん、API 仕様の変化にも追随しやすい。

エラーは llm/base.py と同じ粒度へ正規化する。画面に出したいのは
「キーが違う」「レート制限」「繋がらない」「時間切れ」程度であり、
この切り分けは会社をまたいで共通であるため。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import httpx

from .config import REQUEST_TIMEOUT_SECONDS, api_key, model

#: TypeSafe の System One エンドポイント。
API_URL = "https://api.typesafe.ai/v1/systemone"

ErrorKind = Literal["auth", "rate_limit", "timeout", "network", "bad_request", "unknown"]


@dataclass
class JevError(Exception):
    """Jev 呼び出しの失敗。画面に出す粒度まで正規化したもの。"""

    kind: ErrorKind
    message: str

    def __str__(self) -> str:
        return self.message


async def evaluate(state: str, questions: dict[str, dict[str, object]]) -> dict[str, object]:
    """state を questions で評価し、answers をそのまま返す。

    答えの解釈（どの閾値で押すか）はここでは行わない。サーバは観測値を返すだけに留め、
    判断は呼び出し側に置く。閾値は実測で調整するものであり、サーバへ焼き込むと
    フロントから動かせなくなるため。
    """
    key = api_key()
    if key is None:
        raise JevError("auth", f"{__name__}: API キーが設定されていません")

    payload = {
        "state": state,
        "model": model(),
        "questions": questions,
    }

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(
                API_URL,
                json=payload,
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
            )
    except httpx.TimeoutException as error:
        raise JevError("timeout", f"応答がありませんでした（{REQUEST_TIMEOUT_SECONDS} 秒）") from error
    except httpx.HTTPError as error:
        raise JevError("network", f"接続できませんでした: {error}") from error

    if response.status_code != 200:
        raise _from_status(response)

    try:
        body = response.json()
    except ValueError as error:
        raise JevError("unknown", "応答を JSON として解釈できませんでした") from error

    answers = body.get("answers") if isinstance(body, dict) else None
    if not isinstance(answers, dict):
        raise JevError("unknown", "応答に answers が含まれていませんでした")

    return answers


def _from_status(response: httpx.Response) -> JevError:
    """HTTP ステータスを画面向けの分類へ写す。

    本文の文言には依存しない。TypeSafe 側の文言が変わっても分類が壊れないよう、
    ステータスコードだけで判断する。
    """
    status = response.status_code
    detail = _detail(response)

    if status in (401, 403):
        return JevError("auth", f"認証に失敗しました: {detail}")
    if status == 429:
        return JevError("rate_limit", f"レート制限に達しました: {detail}")
    if status >= 500:
        return JevError("network", f"TypeSafe 側でエラーが発生しました（HTTP {status}）: {detail}")
    if status >= 400:
        return JevError("bad_request", f"リクエストが受け付けられませんでした（HTTP {status}）: {detail}")
    return JevError("unknown", f"想定外の応答です（HTTP {status}）: {detail}")


def _detail(response: httpx.Response) -> str:
    """エラー本文を短く取り出す。長い HTML が返ることもあるため切り詰める。"""
    text = response.text.strip()
    return text[:200] if text else "(本文なし)"
