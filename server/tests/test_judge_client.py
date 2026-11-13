"""TypeSafe アダプタと client の振り分けのテスト。

実際の API は叩かず、httpx のトランスポートを差し替えて応答を作る。
"""

from __future__ import annotations

import httpx
import pytest

from app.judge import client, typesafe
from app.judge.errors import JudgeError


def _mock_transport(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    """httpx.AsyncClient を、handler が応答を返すものへ差し替える。"""
    original = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return original(*args, **kwargs)

    monkeypatch.setattr(typesafe.httpx, "AsyncClient", factory)


@pytest.mark.anyio
async def test_answers_をそのまま返す(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"model": "jev-1.13.0", "answers": {"buzz": {"type": "noul", "noul": 0.9}}},
        )

    _mock_transport(monkeypatch, handler)

    answers = await client.evaluate("日本の", {"buzz": {}})

    assert answers == {"buzz": {"type": "noul", "noul": 0.9}}


@pytest.mark.anyio
async def test_state_と_model_と_questions_を送る(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.setenv("JUDGE_MODEL", "")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured.update(json.loads(request.content))
        captured["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json={"answers": {}})

    _mock_transport(monkeypatch, handler)

    await client.evaluate("日本の小説家で", {"buzz": {"type": "noul"}})

    assert captured["state"] == "日本の小説家で"
    assert captured["model"] == "jev-latest"
    assert captured["questions"] == {"buzz": {"type": "noul"}}
    assert captured["auth"] == "Bearer dummy"


@pytest.mark.anyio
async def test_キーが無ければ_auth_エラー(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    with pytest.raises(JudgeError) as raised:
        await client.evaluate("日本の", {})

    assert raised.value.kind == "auth"
    assert "TYPESAFE_API_KEY" in raised.value.message


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
    """本文の文言ではなくステータスで分類する。"""
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, text="error")

    _mock_transport(monkeypatch, handler)

    with pytest.raises(JudgeError) as raised:
        await client.evaluate("日本の", {})

    assert raised.value.kind == kind


@pytest.mark.anyio
async def test_500_の文面に_TypeSafe_が入る(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    _mock_transport(monkeypatch, handler)

    with pytest.raises(JudgeError) as raised:
        await client.evaluate("日本の", {})

    assert "TypeSafe" in raised.value.message


@pytest.mark.anyio
async def test_タイムアウトは_timeout_として返す(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timeout", request=request)

    _mock_transport(monkeypatch, handler)

    with pytest.raises(JudgeError) as raised:
        await client.evaluate("日本の", {})

    assert raised.value.kind == "timeout"


@pytest.mark.anyio
async def test_answers_が無ければエラーにする(monkeypatch: pytest.MonkeyPatch) -> None:
    """応答の形が変わったことを握り潰さないため。"""
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"model": "jev-1.13.0"})

    _mock_transport(monkeypatch, handler)

    with pytest.raises(JudgeError) as raised:
        await client.evaluate("日本の", {})

    assert raised.value.kind == "unknown"


@pytest.mark.anyio
async def test_JUDGE_PROVIDER_が不正なら_API_を呼ばない(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JUDGE_PROVIDER", "foo")
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    called = False

    async def boom(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("should not be called")

    monkeypatch.setattr(typesafe, "evaluate", boom)

    with pytest.raises(JudgeError) as raised:
        await client.evaluate("日本の", {})

    assert raised.value.kind == "bad_request"
    assert "foo" in raised.value.message
    assert called is False


@pytest.mark.anyio
async def test_JUDGE_MODEL_は既定_provider_だけに効く(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JUDGE_PROVIDER", "typesafe")
    monkeypatch.setenv("JUDGE_MODEL", "custom-jev")
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"answers": {}})

    _mock_transport(monkeypatch, handler)

    await client.evaluate("日本の", {"buzz": {}})
    assert captured["model"] == "custom-jev"

    # openai は未実装スタブなので、model_for だけ確かめる
    from app.judge.config import model_for

    assert model_for("openai") == "gpt-6-luna"
