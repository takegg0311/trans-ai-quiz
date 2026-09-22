"""TypeSafe API クライアントのテスト。

実際の API は叩かず、httpx のトランスポートを差し替えて応答を作る。
"""

from __future__ import annotations

import httpx
import pytest

from app.jev import client as jev_client


def _mock_transport(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    """httpx.AsyncClient を、handler が応答を返すものへ差し替える。"""
    original = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return original(*args, **kwargs)

    monkeypatch.setattr(jev_client.httpx, "AsyncClient", factory)


@pytest.mark.anyio
async def test_answers_をそのまま返す(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"model": "jev-1.13.0", "answers": {"buzz": {"type": "noul", "noul": 0.9}}},
        )

    _mock_transport(monkeypatch, handler)

    answers = await jev_client.evaluate("日本の", {"buzz": {}})

    assert answers == {"buzz": {"type": "noul", "noul": 0.9}}


@pytest.mark.anyio
async def test_state_と_model_と_questions_を送る(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.setenv("JEV_MODEL", "")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured.update(json.loads(request.content))
        captured["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json={"answers": {}})

    _mock_transport(monkeypatch, handler)

    await jev_client.evaluate("日本の小説家で", {"buzz": {"type": "noul"}})

    assert captured["state"] == "日本の小説家で"
    assert captured["model"] == "jev-latest"
    assert captured["questions"] == {"buzz": {"type": "noul"}}
    assert captured["auth"] == "Bearer dummy"


@pytest.mark.anyio
async def test_キーが無ければ_auth_エラー(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "")

    with pytest.raises(jev_client.JevError) as raised:
        await jev_client.evaluate("日本の", {})

    assert raised.value.kind == "auth"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("status", "kind"),
    [
        (401, "auth"),
        (403, "auth"),
        (429, "rate_limit"),
        (400, "bad_request"),
        (500, "network"),
        (503, "network"),
    ],
)
async def test_ステータスから種別を分類する(
    monkeypatch: pytest.MonkeyPatch, status: int, kind: str
) -> None:
    """本文の文言ではなくステータスで分類する。

    TypeSafe 側の文言が変わっても分類が壊れないようにするため。
    """
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, text="error")

    _mock_transport(monkeypatch, handler)

    with pytest.raises(jev_client.JevError) as raised:
        await jev_client.evaluate("日本の", {})

    assert raised.value.kind == kind


@pytest.mark.anyio
async def test_タイムアウトは_timeout_として返す(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timeout", request=request)

    _mock_transport(monkeypatch, handler)

    with pytest.raises(jev_client.JevError) as raised:
        await jev_client.evaluate("日本の", {})

    assert raised.value.kind == "timeout"


@pytest.mark.anyio
async def test_answers_が無ければエラーにする(monkeypatch: pytest.MonkeyPatch) -> None:
    """応答の形が変わったことを握り潰さないため。"""
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"model": "jev-1.13.0"})

    _mock_transport(monkeypatch, handler)

    with pytest.raises(jev_client.JevError) as raised:
        await jev_client.evaluate("日本の", {})

    assert raised.value.kind == "unknown"
