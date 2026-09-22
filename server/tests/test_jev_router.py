"""Jev 判定エンドポイントのテスト。

実際の TypeSafe API は叩かず、client.evaluate を差し替えて検証する。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.jev import router as jev_router
from app.jev.client import JevError
from app.jev.questions import NARROWED_LEVELS


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(jev_router.router)
    with TestClient(app) as test_client:
        yield test_client


def _answers(buzz: float = 0.1, parallel: float = 0.0, narrowed: float = 0.5) -> dict:
    """TypeSafe の応答形。noul に confidence が無いのは仕様どおり。"""
    return {
        "buzz": {"type": "noul", "noul": buzz},
        "parallel": {"type": "noul", "noul": parallel},
        "narrowed": {
            "type": "score",
            "score": narrowed,
            "probabilities": {"0": 0.1, "1": 0.9},
            "confidence": 0.88,
        },
    }


def test_キーがあれば_available(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")

    body = client.get("/api/jev/health").json()

    assert body["available"] is True


def test_キーが無ければ理由付きで_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "")

    body = client.get("/api/jev/health").json()

    assert body["available"] is False
    assert "TYPESAFE_API_KEY" in body["reason"]


def test_health_は_narrowed_の段階数を返す(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """score の値域は 0〜1 ではなく 0〜(段階数-1) であり、取り違えやすい。

    段階数を返しておくことで、フロント側が値域を決め打ちせずに済む。
    """
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy")

    body = client.get("/api/jev/health").json()

    assert body["narrowed_levels"] == NARROWED_LEVELS


def test_judge_は_3_問の値を返す(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_evaluate(state: str, questions: dict) -> dict:
        return _answers(buzz=0.94, parallel=0.02, narrowed=2.9)

    monkeypatch.setattr(jev_router, "evaluate", fake_evaluate)

    body = client.post("/api/jev/judge", json={"partial_text": "日本の小説家で"}).json()

    assert body["ok"] is True
    assert body["buzz"] == 0.94
    assert body["parallel"] == 0.02
    assert body["narrowed"] == 2.9
    assert body["narrowed_confidence"] == 0.88


def test_judge_は_読み上げ済みの文字列だけを送る(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """問題文の全文と正解をサーバへ渡さない原則を守れているかを見る。

    state に渡るのはリクエストの partial_text そのものでなければならない。
    """
    captured: dict[str, object] = {}

    async def fake_evaluate(state: str, questions: dict) -> dict:
        captured["state"] = state
        captured["questions"] = set(questions)
        return _answers()

    monkeypatch.setattr(jev_router, "evaluate", fake_evaluate)

    client.post("/api/jev/judge", json={"partial_text": "日本の小説家で"})

    assert captured["state"] == "日本の小説家で"
    assert captured["questions"] == {"buzz", "parallel", "narrowed"}


def test_judge_は失敗しても_200_で返す(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """読み上げ中は次の文字で再送されるため、1 回の失敗は致命ではない。

    HTTP エラーにすると、フロント側が通信の失敗と観測の失敗を区別できなくなる。
    """

    async def fake_evaluate(state: str, questions: dict) -> dict:
        raise JevError("rate_limit", "レート制限に達しました")

    monkeypatch.setattr(jev_router, "evaluate", fake_evaluate)

    response = client.post("/api/jev/judge", json={"partial_text": "日本の"})

    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert response.json()["error_kind"] == "rate_limit"


def test_値が欠けていれば_None_として返す(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """質問を足したのに応答へ現れない、といった食い違いを握り潰さないため。

    既定値で埋めると、0.0 が「押すな」なのか「値が無かった」のか区別できなくなる。
    """

    async def fake_evaluate(state: str, questions: dict) -> dict:
        return {"buzz": {"type": "noul", "noul": 0.5}}

    monkeypatch.setattr(jev_router, "evaluate", fake_evaluate)

    body = client.post("/api/jev/judge", json={"partial_text": "日本の"}).json()

    assert body["buzz"] == 0.5
    assert body["parallel"] is None
    assert body["narrowed"] is None


def test_空の問題文は受け付けない(client: TestClient) -> None:
    response = client.post("/api/jev/judge", json={"partial_text": ""})

    assert response.status_code == 422
