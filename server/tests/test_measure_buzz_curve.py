"""measure_buzz_curve / analyze_buzz_curve の provider 対応テスト。"""

from __future__ import annotations

import csv
import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def _load(name: str):
    path = SCRIPTS / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


measure = _load("measure_buzz_curve")
analyze = _load("analyze_buzz_curve")


@pytest.mark.anyio
async def test_openai_でキーが無ければ名指しして終了(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("TYPESAFE_API_KEY", "")
    called = False

    async def boom(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("API should not be called")

    monkeypatch.setattr(measure, "evaluate", boom)
    monkeypatch.setattr(measure, "load_questions", lambda: [])

    code = await measure._run(
        limit=1,
        step=5,
        output=tmp_path / "out.csv",
        variant="v3",
        only_parallel=False,
        provider="openai",
    )

    assert code == 1
    assert called is False


@pytest.mark.anyio
async def test_openai_なら_TYPESAFE_が無くても進む(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("TYPESAFE_API_KEY", "")
    monkeypatch.delenv("JUDGE_PROVIDER", raising=False)

    class FakeQuestion:
        id = "q1"
        answers = ["富士山"]
        text = "日本で一番高い山は"  # step=5 でも少なくとも 1 点は測れる長さ

    evaluated: list[tuple] = []

    async def fake_evaluate(text, questions, *, provider=None):
        evaluated.append((text, provider))
        return {"buzz": {"noul": 0.1}}

    monkeypatch.setattr(measure, "evaluate", fake_evaluate)
    monkeypatch.setattr(measure, "load_questions", lambda: [FakeQuestion()])

    code = await measure._run(
        limit=1,
        step=5,
        output=tmp_path / "out.csv",
        variant="v3",
        only_parallel=False,
        provider="openai",
    )

    assert code == 0
    assert evaluated
    assert all(provider == "openai" for _, provider in evaluated)

    with (tmp_path / "out.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["provider"] == "openai"
    assert rows[0]["model"] == "gpt-6-luna"


@pytest.mark.anyio
async def test_provider列の無いCSVへは追記せず止める(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    output = tmp_path / "old.csv"
    output.write_text(
        "variant,question_id,answer,total_chars,chars,partial_text,"
        "buzz,parallel,asking,narrowed,narrowed_confidence,elapsed_ms,error\n",
        encoding="utf-8",
    )
    called = False

    async def boom(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("API should not be called")

    monkeypatch.setattr(measure, "evaluate", boom)

    code = await measure._run(
        limit=1,
        step=5,
        output=output,
        variant="v3",
        only_parallel=False,
        provider="openai",
    )

    assert code == 1
    assert called is False


def test_analyze_は_provider列でまとめる(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    path = tmp_path / "new.csv"
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "provider",
                "model",
                "variant",
                "question_id",
                "answer",
                "total_chars",
                "chars",
                "partial_text",
                "buzz",
                "parallel",
                "asking",
            ],
        )
        writer.writeheader()
        for model, buzz in (("gpt-6-luna", "0.9"), ("gpt-other", "0.5")):
            writer.writerow(
                {
                    "provider": "openai",
                    "model": model,
                    "variant": "v3",
                    "question_id": "q1",
                    "answer": "富士山",
                    "total_chars": "4",
                    "chars": "4",
                    "partial_text": "日本で",
                    "buzz": buzz,
                    "parallel": "0.0",
                    "asking": "0.8",
                }
            )

    rows = analyze._load(path)
    groups = {}
    for row in rows:
        groups.setdefault(analyze._group_key(row), []).append(row)

    assert len(groups) == 2
    titles = {analyze._group_title(key) for key in groups}
    assert "openai / gpt-6-luna / v3" in titles
    assert "openai / gpt-other / v3" in titles


def test_analyze_は古いCSVを_variantだけでまとめる(tmp_path: Path) -> None:
    path = tmp_path / "old.csv"
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "variant",
                "question_id",
                "answer",
                "total_chars",
                "chars",
                "partial_text",
                "buzz",
                "parallel",
                "asking",
            ],
        )
        writer.writeheader()
        writer.writerow(
            {
                "variant": "v3",
                "question_id": "q1",
                "answer": "富士山",
                "total_chars": "4",
                "chars": "4",
                "partial_text": "日本で",
                "buzz": "0.9",
                "parallel": "0.0",
                "asking": "0.8",
            }
        )

    rows = analyze._load(path)
    assert analyze._group_title(analyze._group_key(rows[0])) == "v3"
