"""判定の設定。provider・API キー・モデル名を環境変数から読む。

llm/config.py が既に server/.env を読み込んでいるため、ここでは load_dotenv を
呼ばない。二重に呼んでも実害は無いが、読み込み順の責任が 2 箇所に散る。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

# llm 側の import で server/.env が読み込まれる。この副作用に依存するため、
# 未使用に見えても消さないこと。
from ..llm.config import api_key as _api_key

ProviderId = Literal["typesafe", "openai", "gemini"]

#: 認識する provider。health の providers は常にこの順で返す。
PROVIDER_IDS: tuple[ProviderId, ...] = ("typesafe", "openai", "gemini")

#: リクエストで provider を省略したときの既定。未設定・空文字もこれ。
DEFAULT_PROVIDER: ProviderId = "typesafe"


@dataclass(frozen=True)
class ProviderSpec:
    """provider 1 社ぶんの静的な定義。"""

    id: ProviderId
    #: 画面に出す表示名（エラー文面にも使う）
    label: str
    #: API キーを読む環境変数名
    env_key: str
    #: JUDGE_MODEL が無いとき、または他 provider 向けのときのモデル
    default_model: str
    #: 呼び出し先 URL
    api_url: str


PROVIDERS: dict[ProviderId, ProviderSpec] = {
    "typesafe": ProviderSpec(
        id="typesafe",
        label="TypeSafe",
        env_key="TYPESAFE_API_KEY",
        default_model="jev-latest",
        api_url="https://api.typesafe.ai/v1/systemone",
    ),
    "openai": ProviderSpec(
        id="openai",
        label="OpenAI",
        env_key="OPENAI_API_KEY",
        default_model="gpt-6-luna",
        api_url="https://api.openai.com/v1/decisions",
    ),
    "gemini": ProviderSpec(
        id="gemini",
        label="Gemini",
        env_key="GEMINI_API_KEY",
        default_model="gemini-decision-1",
        api_url="https://generativelanguage.googleapis.com/v1beta/decisions",
    ),
}

#: 1 リクエストの上限（秒）。
#
# llm/ の 60 秒とは前提が違う。あちらは人間が回答欄の前で待つ時間だが、
# こちらは読み上げ中に連続で投げるため、遅い応答は届いても使い道がない
# （その頃には問題文が進み、判定対象が古くなっている）。
REQUEST_TIMEOUT_SECONDS = 5.0

#: 読み切り後、AI が回答に踏み切るまでの待ち時間（ミリ秒）。
DEFAULT_READING_ENDED_DELAY_MS = 5000


def api_key(env_key: str) -> str | None:
    """API キーを読む。未設定と空文字は同じ「未設定」として扱う。"""
    return _api_key(env_key)


def configured_provider_raw() -> str:
    """JUDGE_PROVIDER の生の値。未設定・空文字は既定の typesafe。"""
    raw = os.getenv("JUDGE_PROVIDER")
    if raw is None or raw.strip() == "":
        return DEFAULT_PROVIDER
    return raw.strip()


def configured_provider_id() -> ProviderId | None:
    """JUDGE_PROVIDER を解釈する。不明な値なら None（黙って typesafe に戻さない）。"""
    raw = configured_provider_raw()
    if raw in PROVIDERS:
        return raw  # type: ignore[return-value]
    return None


def model_for(provider_id: ProviderId) -> str:
    """provider が使うモデル名。

    JUDGE_MODEL は JUDGE_PROVIDER で選んだ provider だけに効く。
    他の provider（jev-poc が枠ごとに指定する場合）には既定モデルを返す。
    合わないモデル名を送らないため。
    """
    spec = PROVIDERS[provider_id]
    default_id = configured_provider_id()
    if default_id != provider_id:
        return spec.default_model

    raw = os.getenv("JUDGE_MODEL")
    if raw is None or raw.strip() == "":
        return spec.default_model
    return raw.strip()


def reading_ended_delay_ms() -> int:
    """読み切り後、AI が回答に踏み切るまでの待ち時間。

    毎回読むのは、テストで環境変数を差し替えられるようにするため
    （quiz.py の char_interval_ms と同じ方針）。
    不正な値は既定値へ落とす。0 は「待たない」として認める。
    """
    raw = os.getenv("AI_READING_ENDED_DELAY_MS")
    if raw is None or raw.strip() == "":
        return DEFAULT_READING_ENDED_DELAY_MS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_READING_ENDED_DELAY_MS
    return value if value >= 0 else DEFAULT_READING_ENDED_DELAY_MS
