"""Jev 判定の設定。API キーとモデル名を環境変数から読む。

llm/config.py が既に server/.env を読み込んでいるため、ここでは load_dotenv を
呼ばない。二重に呼んでも実害は無いが、読み込み順の責任が 2 箇所に散る。
"""

from __future__ import annotations

import os

# llm 側の import で server/.env が読み込まれる。この副作用に依存するため、
# 未使用に見えても消さないこと。
from ..llm.config import api_key as _api_key

#: 既定のモデル。TypeSafe は jev-latest で最新へ追従できる。
DEFAULT_MODEL = "jev-latest"

#: API キーを読む環境変数名。
ENV_KEY = "TYPESAFE_API_KEY"

#: 1 リクエストの上限（秒）。
#
# llm/ の 60 秒とは前提が違う。あちらは人間が回答欄の前で待つ時間だが、
# こちらは読み上げ中に連続で投げるため、遅い応答は届いても使い道がない
# （その頃には問題文が進み、判定対象の state が古くなっている）。
# Jev の実測は 70〜500ms なので、それを大きく超えたら捨てる。
REQUEST_TIMEOUT_SECONDS = 5.0


def api_key() -> str | None:
    """Jev の API キーを読む。未設定と空文字は同じ「未設定」として扱う。"""
    return _api_key(ENV_KEY)


def model() -> str:
    """使うモデル名。未設定なら jev-latest。

    毎回読むのは、テストで環境変数を差し替えられるようにするため
    （llm/config.py の plain_answer_max_length と同じ方針）。
    """
    raw = os.getenv("JEV_MODEL")
    if raw is None or raw.strip() == "":
        return DEFAULT_MODEL
    return raw.strip()
