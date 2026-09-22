"""押下判定のテスト。

計測で観測した実際の値を使う。閾値を動かしたときに、どの観測が
どちら側へ倒れるかが分かるようにするため。
"""

from __future__ import annotations

from app.jev.decision import (
    ASKING_MIN,
    BUZZ_STRONG,
    BUZZ_WEAK,
    PARALLEL_RISK_CHARS,
    decide,
    in_parallel_risk,
)

# 危険区間に収まる長さの文字列（実際のパラレル問題の前半）
RISKY = "日本で最も高い山は富士山"
# 危険区間を抜けた長さの文字列
SAFE = "「なぜ山に登るのか？」と聞かれて「そこに山があるから」と答えた逸話で知ら"


def test_危険区間の長さ判定() -> None:
    assert len(RISKY) <= PARALLEL_RISK_CHARS
    assert len(SAFE) > PARALLEL_RISK_CHARS
    assert in_parallel_risk(RISKY) is True
    assert in_parallel_risk(SAFE) is False


def test_強い確信は_asking_を見ずに押す() -> None:
    """転換前の危険点では buzz が 0.86 までしか上がらなかった。

    それを超える確信はパラレル問題では観測されていないため、
    危険区間でも asking を待たずに押す。
    """
    result = decide(RISKY, buzz=BUZZ_STRONG, asking=0.10)

    assert result.press is True


def test_危険区間では_asking_が低いと押さない() -> None:
    """実測値。「日本で最も高い山は富士山」で buzz=0.83 / asking=0.34。

    ここで押すと「富士山」と答えて誤答になる（正解は日和山）。
    """
    result = decide(RISKY, buzz=0.83, asking=0.34)

    assert result.press is False
    assert "asking" in result.reason


def test_危険区間でも_asking_が高ければ押す() -> None:
    result = decide(RISKY, buzz=0.83, asking=ASKING_MIN)

    assert result.press is True


def test_危険区間を抜ければ_asking_を見ない() -> None:
    """実測値。「シカト」は確定点が 43 字で、asking を課すと押せなくなる。

    パラレル問題の転換は 26 字までに現れるため、そこを過ぎれば
    asking で待たせる理由が無い。
    """
    result = decide(SAFE, buzz=BUZZ_WEAK, asking=0.10)

    assert result.press is True
    assert "危険区間" in result.reason


def test_ずばりが出たら危険区間でも押す() -> None:
    """「ずばり」は単刀直入な問いの合図で、転換しない。"""
    text = "ずばり、日本一高い山は"

    assert len(text) <= PARALLEL_RISK_CHARS
    assert in_parallel_risk(text) is False
    assert decide(text, buzz=BUZZ_WEAK, asking=0.10).press is True


def test_buzz_が低ければ押さない() -> None:
    result = decide(SAFE, buzz=BUZZ_WEAK - 0.01, asking=0.99)

    assert result.press is False


def test_buzz_が欠測なら押さない() -> None:
    """値が無いことと 0 であることを取り違えないため。"""
    result = decide(SAFE, buzz=None, asking=0.99)

    assert result.press is False


def test_危険区間で_asking_が欠測なら押さない() -> None:
    result = decide(RISKY, buzz=0.83, asking=None)

    assert result.press is False


def test_押さない場合も理由が残る() -> None:
    """なぜ押さなかったかを画面とログに出すため。"""
    assert decide(RISKY, buzz=0.83, asking=0.34).reason != ""
    assert decide(SAFE, buzz=0.10, asking=0.99).reason != ""
