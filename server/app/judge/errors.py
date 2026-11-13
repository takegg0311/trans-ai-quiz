"""判定 API 呼び出しの失敗。画面に出す粒度まで正規化したもの。

エラー分類（auth / rate_limit / timeout / network / bad_request / unknown）は
全 provider で共通。HTTP ステータスだけで判断し、本文の文言には依存しない。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import httpx

ErrorKind = Literal["auth", "rate_limit", "timeout", "network", "bad_request", "unknown"]


@dataclass
class JudgeError(Exception):
    """判定呼び出しの失敗。"""

    kind: ErrorKind
    message: str

    def __str__(self) -> str:
        return self.message


def from_status(response: httpx.Response, provider_label: str) -> JudgeError:
    """HTTP ステータスを画面向けの分類へ写す。

    5xx の文面にはリクエスト先の provider の表示名を入れる。社名を固定すると
    他社の失敗が誤って表示されるため。
    """
    status = response.status_code
    detail = detail_text(response)

    if status in (401, 403):
        return JudgeError("auth", f"認証に失敗しました: {detail}")
    if status == 429:
        return JudgeError("rate_limit", f"レート制限に達しました: {detail}")
    if status >= 500:
        return JudgeError(
            "network",
            f"{provider_label} 側でエラーが発生しました（HTTP {status}）: {detail}",
        )
    if status >= 400:
        return JudgeError(
            "bad_request",
            f"リクエストが受け付けられませんでした（HTTP {status}）: {detail}",
        )
    return JudgeError("unknown", f"想定外の応答です（HTTP {status}）: {detail}")


def detail_text(response: httpx.Response) -> str:
    """エラー本文を短く取り出す。長い HTML が返ることもあるため切り詰める。"""
    text = response.text.strip()
    return text[:200] if text else "(本文なし)"
