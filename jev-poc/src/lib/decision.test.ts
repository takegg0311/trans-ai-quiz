/**
 * 押下規則のテスト。
 *
 * server/tests/test_jev_decision.py と**同じケース・同じ期待値**を並べる。
 * 規則は Python と TypeScript の両方に定義があり、片方だけ変えると
 * 計測スクリプトで測った成績と実機の挙動がズレる。両方にテストを置くことで、
 * 片方だけの変更がテストで落ちるようにする。
 *
 * 境界値（0.90 / 0.70 / 0.60 / 30 字）は定数から取らず**直接書く**。
 * 定数を参照すると、閾値を変えたときテストも一緒に動いてしまい、
 * 変更に気づけない。
 */
import { describe, expect, it } from 'vitest';
import {
  ASKING_MIN,
  BUZZ_STRONG,
  BUZZ_WEAK,
  PARALLEL_RISK_CHARS,
  decide,
  inParallelRisk,
} from './decision';

/** 危険区間に収まる長さの文字列（実際のパラレル問題の前半） */
const RISKY = '日本で最も高い山は富士山';
/** 危険区間を抜けた長さの文字列 */
const SAFE = '「なぜ山に登るのか？」と聞かれて「そこに山があるから」と答えた逸話で知ら';

describe('閾値', () => {
  it('Python 側と同じ値である', () => {
    // server/app/jev/decision.py と突き合わせること
    expect(BUZZ_STRONG).toBe(0.9);
    expect(BUZZ_WEAK).toBe(0.7);
    expect(ASKING_MIN).toBe(0.6);
    expect(PARALLEL_RISK_CHARS).toBe(30);
  });
});

describe('inParallelRisk', () => {
  it('危険区間の長さを判定する', () => {
    expect([...RISKY].length).toBeLessThanOrEqual(PARALLEL_RISK_CHARS);
    expect([...SAFE].length).toBeGreaterThan(PARALLEL_RISK_CHARS);
    expect(inParallelRisk(RISKY)).toBe(true);
    expect(inParallelRisk(SAFE)).toBe(false);
  });

  it('ちょうど 30 字は危険区間に含む', () => {
    const exactly = 'あ'.repeat(30);

    expect(inParallelRisk(exactly)).toBe(true);
    expect(inParallelRisk(`${exactly}あ`)).toBe(false);
  });

  it('サロゲートペアをコードポイント単位で数える', () => {
    // align.ts の visibleLength と数え方を揃える。UTF-16 の length で
    // 数えると、絵文字や一部の漢字で危険区間の判定がズレる。
    const surrogate = '𠮷'.repeat(20); // length は 40 だがコードポイントは 20

    expect(surrogate.length).toBe(40);
    expect(inParallelRisk(surrogate)).toBe(true);
  });
});

describe('decide', () => {
  it('強い確信は asking を見ずに押す', () => {
    // 転換前の危険点では buzz が 0.86 までしか上がらなかった。
    // それを超える確信はパラレル問題では観測されていない。
    expect(decide(RISKY, 0.9, 0.1).press).toBe(true);
  });

  it('危険区間では asking が低いと押さない', () => {
    // 実測値。「日本で最も高い山は富士山」で buzz=0.83 / asking=0.34。
    // ここで押すと「富士山」と答えて誤答になる（正解は日和山）。
    const result = decide(RISKY, 0.83, 0.34);

    expect(result.press).toBe(false);
    expect(result.reason).toContain('asking');
  });

  it('危険区間でも asking が高ければ押す', () => {
    expect(decide(RISKY, 0.83, 0.6).press).toBe(true);
  });

  it('asking 0.50 台は押さない', () => {
    // 0.50 では「地球で最も高い山」(0.55)「日本で最も高い山」(0.51)
    // 「…西を守っているの」(0.58) を通してしまい、いずれも誤押しになった。
    expect(decide(RISKY, 0.83, 0.55).press).toBe(false);
    expect(decide(RISKY, 0.83, 0.58).press).toBe(false);
  });

  it('危険区間を抜ければ asking を見ない', () => {
    // 実測値。「シカト」は確定点が 43 字で、asking を課すと押せなくなる。
    const result = decide(SAFE, 0.7, 0.1);

    expect(result.press).toBe(true);
    expect(result.reason).toContain('危険区間');
  });

  it('ずばりが出たら危険区間でも押す', () => {
    const text = 'ずばり、日本一高い山は';

    expect([...text].length).toBeLessThanOrEqual(PARALLEL_RISK_CHARS);
    expect(inParallelRisk(text)).toBe(false);
    expect(decide(text, 0.7, 0.1).press).toBe(true);
  });

  it('buzz が低ければ押さない', () => {
    expect(decide(SAFE, 0.69, 0.99).press).toBe(false);
  });

  it('buzz が欠測なら押さない', () => {
    // 値が無いことと 0 であることを取り違えないため
    expect(decide(SAFE, null, 0.99).press).toBe(false);
  });

  it('危険区間で asking が欠測なら押さない', () => {
    expect(decide(RISKY, 0.83, null).press).toBe(false);
  });

  it('押さない場合も理由が残る', () => {
    // なぜ押さなかったかを画面とログに出すため
    expect(decide(RISKY, 0.83, 0.34).reason).not.toBe('');
    expect(decide(SAFE, 0.1, 0.99).reason).not.toBe('');
  });
});
