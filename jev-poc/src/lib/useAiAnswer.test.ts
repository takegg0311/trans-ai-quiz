/**
 * AI の回答の非同期制御のテスト。
 *
 * 合議の規則（consensus.ts）と状態遷移（quizMachine.ts）はそれぞれ固定して
 * あるが、**両者を繋ぐ部分**——応答の到着順、早期確定、世代管理——は
 * 型でもテストでも落ちない経路だった。
 *
 * ここで固定するのは「いつ onSettled が呼ばれ、いつ呼ばれないか」である。
 * onSettled は正誤判定と遷移を起こすため、余分に呼ぶと勝敗が二重に確定し、
 * 呼ばれないと出題が止まる。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as llm from './llm';
import { OPPONENTS, useAiAnswer } from './useAiAnswer';

function ok(answer: string, elapsedMs = 1000): llm.PredictResult {
  return { status: 'ok', continuation: null, answer, elapsedMs, raw: '' };
}

function failure(): llm.PredictResult {
  return { status: 'error', kind: 'timeout', message: '応答がありません', elapsedMs: 60000 };
}

/** 3 モデルすべてが使える health 応答 */
function providers(): llm.ProviderInfo[] {
  return OPPONENTS.map((opponent) => ({
    vendor: opponent.vendor,
    label: opponent.label,
    available: true,
    models: [opponent.model],
  }));
}

/** health が online になるまで待つ。これを待たないと run が送らない */
async function mount() {
  const hook = renderHook(() => useAiAnswer());
  await waitFor(() => expect(hook.result.current.health).toBe('online'));
  return hook;
}

/** 応答を任意のタイミングで返せるようにする */
function deferred() {
  const resolvers: ((value: llm.PredictResult) => void)[] = [];
  vi.spyOn(llm, 'predict').mockImplementation(
    () =>
      new Promise<llm.PredictResult>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  return resolvers;
}

beforeEach(() => {
  vi.spyOn(llm, 'checkHealth').mockResolvedValue(providers());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('早期確定', () => {
  it('2 モデルが一致したら 3 モデル目を待たずに onSettled を呼ぶ', async () => {
    const resolvers = deferred();
    const { result } = await mount();
    const onSettled = vi.fn();

    act(() => {
      result.current.run('問題文', onSettled);
    });

    await act(async () => {
      resolvers[0]?.(ok('富士山', 1000));
    });
    expect(onSettled).not.toHaveBeenCalled();

    await act(async () => {
      resolvers[1]?.(ok('富士山', 1200));
    });

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.[0].answer).toBe('富士山');
  });

  it('確定後に届いた応答では onSettled を呼ばない', async () => {
    const resolvers = deferred();
    const { result } = await mount();
    const onSettled = vi.fn();

    act(() => {
      result.current.run('問題文', onSettled);
    });
    await act(async () => {
      resolvers[0]?.(ok('富士山', 1000));
      resolvers[1]?.(ok('富士山', 1200));
    });
    await act(async () => {
      resolvers[2]?.(ok('エベレスト', 800));
    });

    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('確定後に届いた応答も表示へは反映する', async () => {
    // 勝敗には影響させないが、どのモデルが何を答えたかは残す
    const resolvers = deferred();
    const { result } = await mount();

    act(() => {
      result.current.run('問題文', vi.fn());
    });
    await act(async () => {
      resolvers[0]?.(ok('富士山', 1000));
      resolvers[1]?.(ok('富士山', 1200));
    });
    await act(async () => {
      resolvers[2]?.(ok('エベレスト', 800));
    });

    expect(result.current.state.slots.every((slot) => slot.state === 'done')).toBe(true);
    // 確定した答えは書き換えない
    expect(result.current.state.consensus?.answer).toBe('富士山');
  });

  it('2 モデルが異なれば 3 モデル目を待つ', async () => {
    const resolvers = deferred();
    const { result } = await mount();
    const onSettled = vi.fn();

    act(() => {
      result.current.run('問題文', onSettled);
    });
    await act(async () => {
      resolvers[0]?.(ok('富士山', 1000));
      resolvers[1]?.(ok('エベレスト', 1200));
    });

    expect(onSettled).not.toHaveBeenCalled();

    await act(async () => {
      resolvers[2]?.(ok('北岳', 800));
    });

    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

describe('世代の管理', () => {
  it('reset 後に届いた応答では onSettled を呼ばない', async () => {
    // 次の問題へ進んだ後に前問の応答が届いても、勝敗を確定させない
    const resolvers = deferred();
    const { result } = await mount();
    const onSettled = vi.fn();

    act(() => {
      result.current.run('問題文', onSettled);
    });
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      resolvers[0]?.(ok('富士山', 1000));
      resolvers[1]?.(ok('富士山', 1200));
    });

    expect(onSettled).not.toHaveBeenCalled();
  });

  it('reset 後の応答で表示も変えない', async () => {
    const resolvers = deferred();
    const { result } = await mount();

    act(() => {
      result.current.run('問題文', vi.fn());
    });
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      resolvers[0]?.(ok('富士山', 1000));
    });

    expect(result.current.state.slots.every((slot) => slot.state === 'idle')).toBe(true);
  });
});

describe('全滅', () => {
  it('全モデルが失敗したら回答なしで確定する', async () => {
    const resolvers = deferred();
    const { result } = await mount();
    const onSettled = vi.fn();

    act(() => {
      result.current.run('問題文', onSettled);
    });
    await act(async () => {
      resolvers.forEach((resolve) => resolve(failure()));
    });

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.[0].answer).toBeNull();
  });
});

describe('疎通していない場合', () => {
  it('送信せずその場で回答なしを返す', async () => {
    // キー未設定でも /predict は呼べてしまい、3 本が 60 秒のタイムアウトまで
    // 走る。その間 aiAnswering のままで人間も押せず、出題が 1 分止まる。
    vi.spyOn(llm, 'checkHealth').mockResolvedValue(null);
    const predict = vi.spyOn(llm, 'predict');
    const hook = renderHook(() => useAiAnswer());
    await waitFor(() => expect(hook.result.current.health).toBe('offline'));

    const onSettled = vi.fn();
    act(() => {
      hook.result.current.run('問題文', onSettled);
    });

    expect(predict).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.[0].answer).toBeNull();
  });

  it('対決に使うモデルが 1 つでも欠けたら offline にする', async () => {
    // 3 者の多数決が前提。1 つ欠けると合議の性質が変わる
    vi.spyOn(llm, 'checkHealth').mockResolvedValue(
      providers().filter((provider) => provider.vendor !== 'xai'),
    );
    const hook = renderHook(() => useAiAnswer());

    await waitFor(() => expect(hook.result.current.health).toBe('offline'));
  });
});

describe('送信', () => {
  it('3 モデルすべてへ同じ問題文を送る', async () => {
    const predict = vi.spyOn(llm, 'predict').mockResolvedValue(ok('富士山'));
    const { result } = await mount();

    await act(async () => {
      result.current.run('日本で最も高い山は', vi.fn());
    });

    expect(predict).toHaveBeenCalledTimes(OPPONENTS.length);
    for (const opponent of OPPONENTS) {
      expect(predict).toHaveBeenCalledWith(
        opponent.vendor,
        opponent.model,
        '日本で最も高い山は',
        false,
      );
    }
  });
});
