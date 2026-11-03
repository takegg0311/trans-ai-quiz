"""ビルド済みフロントエンド（web/dist）の配信。ローカル版とクラウド版で共有する。

HTML には Cache-Control: no-cache を付ける。付けないとブラウザが last-modified から
経験則でキャッシュし、ビルドを更新しても古い HTML を使い続ける。古い HTML は古い
ハッシュ名の JS を参照するため、参加者の画面が更新されない。実際に、LAN のスマホで
再ビルド後も古い回答者画面が出続けた。

no-store ではなく no-cache にするのは、etag による再検証（304）を残すため。
assets/ 配下はファイル名にハッシュが入り、中身が変われば名前も変わるので、
ヘッダを付けずにブラウザのキャッシュに任せる。
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.staticfiles import PathLike
from starlette.types import Scope

HTML_CACHE_CONTROL = "no-cache"

_HTML_SUFFIX = ".html"


def html_response(path: Path) -> FileResponse:
    """HTML ファイルを、ブラウザに毎回再検証させる形で返す。"""
    return FileResponse(path, headers={"Cache-Control": HTML_CACHE_CONTROL})


class DistStaticFiles(StaticFiles):
    """web/dist を配信する StaticFiles。HTML にだけ Cache-Control を付ける。"""

    def file_response(
        self,
        full_path: PathLike,
        stat_result: os.stat_result,
        scope: Scope,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        if os.fspath(full_path).endswith(_HTML_SUFFIX):
            response.headers["Cache-Control"] = HTML_CACHE_CONTROL
        return response
