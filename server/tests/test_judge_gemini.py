"""Gemini Decision 1 アダプタのテスト。"""

from __future__ import annotations

import json

import httpx
import pytest

from app.judge import gemini_provider
from app.judge.client import evaluate
from app.judge.errors import JudgeError
from app.judge.questions import ACTIVE_QUESTIONS


def _mock_transport(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    original = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return original(*args, **kwargs)

    monkeypatch.setattr(gemini_provider.httpx, "AsyncClient", factory)


@pytest.mark.anyio
async def test_送信ヘッダと_criteria_の形(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-key")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["api_key"] = request.headers.get("x-goog-api-key")
        captured["auth"] = request.headers.get("Authorization")
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "answers": {
                    "buzz": {"type": "noul", "noul": 0.82, "confidence": 0.82},
                    "narrowed": {
                        "type": "score",
                        "score": 2.1,
                        "confidence": 0.7,
                        "legend": {"0": "…"},
                        "probabilities": {"0": 0.05},
                    },
                }
            },
        )

    _mock_transport(monkeypatch, handler)

    answers = await evaluate("日本の小説家で", ACTIVE_QUESTIONS, provider="gemini")

    assert captured["url"] == (
        "https://generativelanguage.googleapis.com/v1beta/decisions"
    )
    assert captured["api_key"] == "gemini-key"
    assert captured["auth"] is None

    body = captured["body"]
    assert isinstance(body, dict)
    assert body["model"] == "gemini-decision-1"
    assert body["input"] == "日本の小説家で"
    assert isinstance(body["questions"], dict)

    buzz = body["questions"]["buzz"]
    assert buzz["type"] == "noul"
    assert "true_description" in buzz["criteria"]
    assert "false_description" in buzz["criteria"]
    assert "true" not in buzz["criteria"]

    narrowed = body["questions"]["narrowed"]
    assert narrowed["type"] == "score"
    assert narrowed["criteria"][0] == "話題の分野すら定まらない"

    assert answers == {
        "buzz": {"noul": 0.82},
        "narrowed": {"score": 2.1, "confidence": 0.7},
    }


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
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-key")

    def handler(request: httpx.Request) -> httpx.Response:
        # 安全性ブロックも HTTP 400。本文は先頭 200 字だけメッセージに入る
        return httpx.Response(
            status,
            json={"error": {"code": "safety", "message": "blocked"}},
        )

    _mock_transport(monkeypatch, handler)

    with pytest.raises(JudgeError) as raised:
        await gemini_provider.evaluate(
            "日本の", {}, model="gemini-decision-1", api_key="gemini-key"
        )

    assert raised.value.kind == kind
    if status >= 500:
        assert "Gemini" in raised.value.message
        assert "TypeSafe" not in raised.value.message
    if status == 400:
        assert "safety" in raised.value.message or "blocked" in raised.value.message


@pytest.mark.anyio
async def test_タイムアウト(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-key")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timeout", request=request)

    _mock_transport(monkeypatch, handler)

    with pytest.raises(JudgeError) as raised:
        await gemini_provider.evaluate(
            "日本の", {}, model="gemini-decision-1", api_key="gemini-key"
        )

    assert raised.value.kind == "timeout"


@pytest.mark.anyio
async def test_JUDGE_MODEL_は_gemini_既定には効かない(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JUDGE_PROVIDER", "typesafe")
    monkeypatch.setenv("JUDGE_MODEL", "custom-jev")
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-key")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"answers": {}})

    _mock_transport(monkeypatch, handler)

    await evaluate("日本の", {"buzz": ACTIVE_QUESTIONS["buzz"]}, provider="gemini")

    assert captured["model"] == "gemini-decision-1"
