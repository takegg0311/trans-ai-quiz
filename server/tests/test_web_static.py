"""web/dist 配信のキャッシュ制御のテスト。

main.py と cloud/app.py は web/dist の有無を固定パスで判定するため、
共有している web_static の部品を、一時ディレクトリの dist で直接確かめる。
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.testclient import TestClient

from app.web_static import HTML_CACHE_CONTROL, DistStaticFiles, html_response


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    (tmp_path / "player.html").write_text("<!doctype html>", encoding="utf-8")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "player-abc123.js").write_text("export {};", encoding="utf-8")

    app = FastAPI()

    @app.get("/player")
    async def player_page() -> FileResponse:
        return html_response(tmp_path / "player.html")

    app.mount("/", DistStaticFiles(directory=tmp_path), name="web")

    with TestClient(app) as test_client:
        yield test_client


class TestHtmlCacheControl:
    def test_ルートで返すHTMLは再検証させる(self, client: TestClient) -> None:
        response = client.get("/player")
        assert response.status_code == 200
        assert response.headers["cache-control"] == HTML_CACHE_CONTROL

    def test_静的配信のHTMLも再検証させる(self, client: TestClient) -> None:
        response = client.get("/player.html")
        assert response.status_code == 200
        assert response.headers["cache-control"] == HTML_CACHE_CONTROL

    def test_ハッシュ付きの資産には付けない(self, client: TestClient) -> None:
        response = client.get("/assets/player-abc123.js")
        assert response.status_code == 200
        assert "cache-control" not in response.headers

    def test_再検証で変更が無ければ304を返す(self, client: TestClient) -> None:
        etag = client.get("/player.html").headers["etag"]
        response = client.get("/player.html", headers={"If-None-Match": etag})
        assert response.status_code == 304
