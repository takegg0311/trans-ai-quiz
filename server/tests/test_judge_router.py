"""判定エンドポイントのテスト。

実際の外部 API は叩かず、client.evaluate を差し替えて検証する。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.judge import router as judge_router
from app.judge.errors import JudgeError
from app.judge.questions import ACTIVE_QUESTIONS, NARROWED_LEVELS


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(judge_router.router)
    with TestClient(app) as test_client:
        yield test_client


def _answers(
    buzz: float = 0.1,
    parallel: float = 0.0,
    narrowed: float = 0.5,
    asking: float = 0.5,
) -> dict:
    """標準形式の応答。noul に confidence が無いのは仕様どおり。"""
    return {
        "buzz": {"type": "noul", "noul": buzz},
        "parallel": {"type": "noul", "noul": parallel},
        "asking": {"type": "noul", "noul": asking},
        "narrowed": {
            "type": "score",
            "score": narrowed,
            "probabilities": {"0": 0.1, "1": 0.9},
            "confidence": 0.88,
        },
    }


def test_キーがあれば_available(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    body = client.get("/api/judge/health").json()

    assert body["available"] is True
    assert body["provider"] == "typesafe"
    assert body["model"] == "jev-latest"
    assert body["reading_ended_delay_ms"] == 5000
    assert body["narrowed_levels"] == NARROWED_LEVELS
    assert len(body["providers"]) == 3
    assert {item["id"] for item in body["providers"]} == {"typesafe", "openai", "gemini"}


def test_キーが無ければ理由付きで_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    body = client.get("/api/judge/health").json()

    assert body["available"] is False
    assert "TYPESAFE_API_KEY" in body["reason"]


def test_openai_なのにキーが無ければ_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("JUDGE_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")

    body = client.get("/api/judge/health").json()

    assert body["available"] is False
    assert body["provider"] == "openai"
    assert "OPENAI_API_KEY" in body["reason"]
    # providers は 3 社分を返す
    assert len(body["providers"]) == 3


def test_JUDGE_PROVIDER_が不明でも_providers_は3社(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("JUDGE_PROVIDER", "foo")
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")

    body = client.get("/api/judge/health").json()

    assert body["available"] is False
    assert body["provider"] == "foo"
    assert "foo" in body["reason"]
    assert len(body["providers"]) == 3


def test_providers_のキー有無が_available_に反映される(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-key")

    body = client.get("/api/judge/health").json()
    by_id = {item["id"]: item for item in body["providers"]}

    assert by_id["typesafe"]["available"] is True
    assert by_id["openai"]["available"] is False
    assert "OPENAI_API_KEY" in by_id["openai"]["reason"]
    assert by_id["gemini"]["available"] is True
    assert by_id["gemini"]["model"] == "gemini-decision-1"


def test_health_は_narrowed_の段階数を返す(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    body = client.get("/api/judge/health").json()

    assert body["narrowed_levels"] == NARROWED_LEVELS


def test_judge_は各質問の値を返す(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_evaluate(text: str, questions: dict, *, provider=None) -> dict:
        return _answers(buzz=0.94, parallel=0.02, narrowed=2.9, asking=0.81)

    monkeypatch.setattr(judge_router, "evaluate", fake_evaluate)

    body = client.post("/api/judge/judge", json={"partial_text": "日本の小説家で"}).json()

    assert body["ok"] is True
    assert body["buzz"] == 0.94
    assert body["parallel"] == 0.02
    assert body["asking"] == 0.81
    assert body["narrowed"] == 2.9
    assert body["narrowed_confidence"] == 0.88


def test_judge_は_asking_を返す(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_evaluate(text: str, questions: dict, *, provider=None) -> dict:
        return _answers()

    monkeypatch.setattr(judge_router, "evaluate", fake_evaluate)

    body = client.post("/api/judge/judge", json={"partial_text": "日本の"}).json()

    assert "asking" in ACTIVE_QUESTIONS
    assert body["asking"] is not None


def test_judge_は_読み上げ済みの文字列だけを送る(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, object] = {}

    async def fake_evaluate(text: str, questions: dict, *, provider=None) -> dict:
        captured["text"] = text
        captured["questions"] = set(questions)
        captured["provider"] = provider
        return _answers()

    monkeypatch.setattr(judge_router, "evaluate", fake_evaluate)

    client.post("/api/judge/judge", json={"partial_text": "日本の小説家で"})

    assert captured["text"] == "日本の小説家で"
    assert captured["questions"] == set(ACTIVE_QUESTIONS)
    assert captured["provider"] is None


def test_judge_は_provider_を渡せばそれを使う(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, object] = {}

    async def fake_evaluate(text: str, questions: dict, *, provider=None) -> dict:
        captured["provider"] = provider
        return _answers()

    monkeypatch.setattr(judge_router, "evaluate", fake_evaluate)

    client.post(
        "/api/judge/judge",
        json={"partial_text": "日本の", "provider": "gemini"},
    )

    assert captured["provider"] == "gemini"


def test_不明な_provider_は_422(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    response = client.post(
        "/api/judge/judge",
        json={"partial_text": "日本の", "provider": "foo"},
    )

    assert response.status_code == 422


def test_JUDGE_PROVIDER_不正で_provider_省略なら_bad_request(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """外部 API を呼ばずに ok: false / bad_request を返す。"""
    monkeypatch.setenv("JUDGE_PROVIDER", "foo")
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")

    from app.judge.client import evaluate as real_evaluate

    monkeypatch.setattr(judge_router, "evaluate", real_evaluate)

    body = client.post("/api/judge/judge", json={"partial_text": "日本の"}).json()

    assert body["ok"] is False
    assert body["error_kind"] == "bad_request"
    assert "foo" in body["error"]


def test_judge_は失敗しても_200_で返す(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_evaluate(text: str, questions: dict, *, provider=None) -> dict:
        raise JudgeError("rate_limit", "レート制限に達しました")

    monkeypatch.setattr(judge_router, "evaluate", fake_evaluate)

    response = client.post("/api/judge/judge", json={"partial_text": "日本の"})

    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert response.json()["error_kind"] == "rate_limit"


def test_値が欠けていれば_None_として返す(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_evaluate(text: str, questions: dict, *, provider=None) -> dict:
        return {"buzz": {"type": "noul", "noul": 0.5}}

    monkeypatch.setattr(judge_router, "evaluate", fake_evaluate)

    body = client.post("/api/judge/judge", json={"partial_text": "日本の"}).json()

    assert body["buzz"] == 0.5
    assert body["parallel"] is None
    assert body["narrowed"] is None


def test_空の問題文は受け付けない(client: TestClient) -> None:
    response = client.post("/api/judge/judge", json={"partial_text": ""})

    assert response.status_code == 422


def test_health_は読み切り後の待ち時間を返す(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.setenv("AI_READING_ENDED_DELAY_MS", "3000")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    assert client.get("/api/judge/health").json()["reading_ended_delay_ms"] == 3000


def test_待ち時間は_0_を認める(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.setenv("AI_READING_ENDED_DELAY_MS", "0")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    assert client.get("/api/judge/health").json()["reading_ended_delay_ms"] == 0


def test_待ち時間が不正なら既定値へ落とす(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")
    monkeypatch.setenv("AI_READING_ENDED_DELAY_MS", "abc")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    assert client.get("/api/judge/health").json()["reading_ended_delay_ms"] == 5000
