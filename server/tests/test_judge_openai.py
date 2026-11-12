"""OpenAI Decisions アダプタのテスト。"""

from __future__ import annotations

import json

import httpx
import pytest

from app.judge import openai_provider
from app.judge.client import evaluate
from app.judge.errors import JudgeError
from app.judge.questions import ACTIVE_QUESTIONS


def _mock_transport(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    original = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return original(*args, **kwargs)

    monkeypatch.setattr(openai_provider.httpx, "AsyncClient", factory)


@pytest.mark.anyio
async def test_送信JSONが_predicate_と_levels_になる(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("Authorization")
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "answers": [
                    {"type": "predicate", "name": "buzz", "probability": 0.82},
                    {
                        "type": "score",
                        "name": "narrowed",
                        "score": 2.1,
                        "confidence": 0.7,
                    },
                ]
            },
        )

    _mock_transport(monkeypatch, handler)

    answers = await evaluate("日本の小説家で", ACTIVE_QUESTIONS, provider="openai")

    assert captured["url"] == "https://api.openai.com/v1/decisions"
    assert captured["auth"] == "Bearer openai-key"
    body = captured["body"]
    assert isinstance(body, dict)
    assert body["model"] == "gpt-6-luna"
    assert body["input"] == "日本の小説家で"
    assert isinstance(body["questions"], list)

    by_name = {item["name"]: item for item in body["questions"]}
    buzz = by_name["buzz"]
    assert buzz["type"] == "predicate"
    assert "真とは:" in buzz["instructions"]
    assert "偽とは:" in buzz["instructions"]
    assert "criteria" not in buzz

    narrowed = by_name["narrowed"]
    assert narrowed["type"] == "score"
    assert narrowed["levels"][0] == {"label": "話題の分野すら定まらない"}
    assert answers == {
        "buzz": {"noul": 0.82},
        "narrowed": {"score": 2.1, "confidence": 0.7},
    }


@pytest.mark.anyio
async def test_refusal_は欠測になる(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "answers": [
                    {"type": "predicate", "name": "buzz", "probability": 0.5},
                    {"type": "refusal", "name": "asking"},
                ]
            },
        )

    _mock_transport(monkeypatch, handler)

    answers = await openai_provider.evaluate(
        "日本の",
        {
            "buzz": ACTIVE_QUESTIONS["buzz"],
            "asking": ACTIVE_QUESTIONS["asking"],
        },
        model="gpt-6-luna",
        api_key="openai-key",
    )

    assert answers == {"buzz": {"noul": 0.5}}
    assert "asking" not in answers


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("status", "kind"),
    [
        (401, "auth"),
        (429, "rate_limit"),
        (400, "bad_request"),
        (500, "network"),
    ],
)
async def test_ステータス分類(
    monkeypatch: pytest.MonkeyPatch, status: int, kind: str
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, text="error")

    _mock_transport(monkeypatch, handler)

    with pytest.raises(JudgeError) as raised:
        await openai_provider.evaluate(
            "日本の", {}, model="gpt-6-luna", api_key="openai-key"
        )

    assert raised.value.kind == kind
    if status >= 500:
        assert "OpenAI" in raised.value.message
        assert "TypeSafe" not in raised.value.message


@pytest.mark.anyio
async def test_タイムアウト(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timeout", request=request)

    _mock_transport(monkeypatch, handler)

    with pytest.raises(JudgeError) as raised:
        await openai_provider.evaluate(
            "日本の", {}, model="gpt-6-luna", api_key="openai-key"
        )

    assert raised.value.kind == "timeout"


@pytest.mark.anyio
async def test_JUDGE_MODEL_は_openai_既定には効かない(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """JUDGE_PROVIDER=typesafe のとき、openai 枠には既定モデルを送る。"""
    monkeypatch.setenv("JUDGE_PROVIDER", "typesafe")
    monkeypatch.setenv("JUDGE_MODEL", "custom-jev")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"answers": []})

    _mock_transport(monkeypatch, handler)

    await evaluate("日本の", {"buzz": ACTIVE_QUESTIONS["buzz"]}, provider="openai")

    assert captured["model"] == "gpt-6-luna"
