/**
 * 自動早押しの非同期制御のテスト。
 *
 * 判定は数百ミリ秒かかるため、応答が届く頃には状況が変わっていることがある。
 * 次の問題へ進んだ、人間が先に押した、自動を切った、読み切った。
 * ここで固定するのは、**そうした応答が届いたときに何が起きるか**である。
 *
 * いずれもレビュー（Composer 2.5 / Grok 4.7）で指摘された不具合に対応する。
 * 型だけでは落ちない経路なので、テストで固定する。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as jev from './jev';
import { useAutoBuzz } from './useAutoBuzz';

/** 押すと判断される観測値 */
const PRESS: jev.JudgeResult = {
  status: 'ok',
  buzz: 0.95,
  parallel: 0.1,
  asking: 0.9,
  narrowed: 2.9,
  elapsedMs: 100,
};

/** 押さないと判断される観測値 */
const HOLD: jev.JudgeResult = { ...PRESS, buzz: 0.1 };

/** 読み上げ済みの文字列。危険区間を抜けた長さにしておく */
const TEXT = 'あ'.repeat(40);

function online() {
  return vi.spyOn(jev, 'checkHealth').mockResolvedValue({
    available: true,
    model: 'jev-latest',
    narrowedLevels: 4,
  });
}

/** health が online になるまで待つ。これを待たないと feed が送らない */
async function mount(onPress: (chars: number, reason: string) => boolean) {
  const hook = renderHook(() => useAutoBuzz(onPress));
  await waitFor(() => expect(hook.result.current.health).toBe('online'));
  return hook;
}

beforeEach(() => {
  online();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('押下の受理', () => {
  it('受理されれば押下済みになり、以降は判定しない', async () => {
    const judge = vi.spyOn(jev, 'judge').mockResolvedValue(PRESS);
    const onPress = vi.fn().mockReturnValue(true);
    const { result } = await mount(onPress);

    await act(async () => {
      result.current.feed(TEXT, 40);
    });
    await waitFor(() => expect(onPress).toHaveBeenCalledTimes(1));

    // 押下済みなので、文字が進んでも送らない
    await act(async () => {
      result.current.feed(TEXT, 41);
    });

    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('受理されなければ押下済みにせず、次の文字で判定を続ける', async () => {
    // 読み切られていた・人間が先に押していた場合、呼び出し側は押せない。
    // ここで押下済みにすると、以降の判定まで止まってしまう。
    const judge = vi.spyOn(jev, 'judge').mockResolvedValue(PRESS);
    const onPress = vi.fn().mockReturnValue(false);
    const { result } = await mount(onPress);

    await act(async () => {
      result.current.feed(TEXT, 40);
    });
    await waitFor(() => expect(onPress).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.feed(TEXT, 41);
    });
    await waitFor(() => expect(judge).toHaveBeenCalledTimes(2));
  });
});

describe('自動のオン / オフ', () => {
  it('送信後にオフへ切り替えたら、届いた応答で押さない', async () => {
    // enabled を送信時のクロージャで見ていると、オフにした後に
    // 届いた応答で押してしまう。
    let release: (value: jev.JudgeResult) => void = () => {};
    vi.spyOn(jev, 'judge').mockReturnValue(
      new Promise<jev.JudgeResult>((resolve) => {
        release = resolve;
      }),
    );
    const onPress = vi.fn().mockReturnValue(true);
    const { result } = await mount(onPress);

    await act(async () => {
      result.current.feed(TEXT, 40);
    });

    // 応答が返る前にオフへ
    act(() => {
      result.current.setEnabled(false);
    });
    await act(async () => {
      release(PRESS);
    });

    expect(onPress).not.toHaveBeenCalled();
  });

  it('オフの間は送信しない', async () => {
    const judge = vi.spyOn(jev, 'judge').mockResolvedValue(HOLD);
    const { result } = await mount(vi.fn().mockReturnValue(true));

    act(() => {
      result.current.setEnabled(false);
    });
    await act(async () => {
      result.current.feed(TEXT, 40);
    });

    expect(judge).not.toHaveBeenCalled();
  });
});

describe('世代の管理', () => {
  it('前問の応答では押さない', async () => {
    let release: (value: jev.JudgeResult) => void = () => {};
    vi.spyOn(jev, 'judge').mockReturnValue(
      new Promise<jev.JudgeResult>((resolve) => {
        release = resolve;
      }),
    );
    const onPress = vi.fn().mockReturnValue(true);
    const { result } = await mount(onPress);

    await act(async () => {
      result.current.feed(TEXT, 40);
    });

    // 次の問題へ進む
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      release(PRESS);
    });

    expect(onPress).not.toHaveBeenCalled();
  });

  it('前問の応答が、次の問題の送信中フラグを落とさない', async () => {
    // フラグを世代チェックより前に戻すと、1 問のあいだに判定が何本も走り、
    // 古い断片の判定が後から届いて押しうる。
    const pending: ((value: jev.JudgeResult) => void)[] = [];
    const judge = vi.spyOn(jev, 'judge').mockImplementation(
      () =>
        new Promise<jev.JudgeResult>((resolve) => {
          pending.push(resolve);
        }),
    );
    const { result } = await mount(vi.fn().mockReturnValue(true));

    // 前問で 1 本送信（未返却のまま）
    await act(async () => {
      result.current.feed(TEXT, 40);
    });
    expect(judge).toHaveBeenCalledTimes(1);

    // 次の問題へ進み、1 本送信
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      result.current.feed(TEXT, 10);
    });
    expect(judge).toHaveBeenCalledTimes(2);

    // ここで前問の応答が届く
    const first = pending[0];
    expect(first).toBeDefined();
    await act(async () => {
      first?.(HOLD);
    });

    // 現在の問題はまだ送信中なので、新たに送ってはいけない
    await act(async () => {
      result.current.feed(TEXT, 11);
    });

    expect(judge).toHaveBeenCalledTimes(2);
  });
});

describe('stop', () => {
  it('手動で押した後は判定しない', async () => {
    const judge = vi.spyOn(jev, 'judge').mockResolvedValue(HOLD);
    const { result } = await mount(vi.fn().mockReturnValue(true));

    act(() => {
      result.current.stop();
    });
    await act(async () => {
      result.current.feed(TEXT, 40);
    });

    expect(judge).not.toHaveBeenCalled();
  });

  it('stop の後に届いた応答では押さない', async () => {
    let release: (value: jev.JudgeResult) => void = () => {};
    vi.spyOn(jev, 'judge').mockReturnValue(
      new Promise<jev.JudgeResult>((resolve) => {
        release = resolve;
      }),
    );
    const onPress = vi.fn().mockReturnValue(true);
    const { result } = await mount(onPress);

    await act(async () => {
      result.current.feed(TEXT, 40);
    });
    act(() => {
      result.current.stop();
    });
    await act(async () => {
      release(PRESS);
    });

    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('送信の間引き', () => {
  it('同じ文字数では送らない', async () => {
    const judge = vi.spyOn(jev, 'judge').mockResolvedValue(HOLD);
    const { result } = await mount(vi.fn().mockReturnValue(true));

    await act(async () => {
      result.current.feed(TEXT, 40);
    });
    await act(async () => {
      result.current.feed(TEXT, 40);
    });

    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('応答待ちの間は送らない', async () => {
    const pending: ((value: jev.JudgeResult) => void)[] = [];
    const judge = vi.spyOn(jev, 'judge').mockImplementation(
      () =>
        new Promise<jev.JudgeResult>((resolve) => {
          pending.push(resolve);
        }),
    );
    const { result } = await mount(vi.fn().mockReturnValue(true));

    await act(async () => {
      result.current.feed(TEXT, 40);
    });
    await act(async () => {
      result.current.feed(TEXT, 41);
    });

    expect(judge).toHaveBeenCalledTimes(1);
  });
});

describe('疎通確認', () => {
  it('古い確認の結果で新しい結果を上書きしない', async () => {
    // 「再チェック」を続けて押すと確認が複数本走る。先に投げたものが
    // 後から返ると、疎通しているのに offline を書いてしまう。
    let releaseSlow: (value: jev.JevHealth | null) => void = () => {};
    vi.spyOn(jev, 'checkHealth')
      .mockReturnValueOnce(
        new Promise<jev.JevHealth | null>((resolve) => {
          releaseSlow = resolve;
        }),
      )
      .mockResolvedValue({ available: true, model: 'jev-latest', narrowedLevels: 4 });

    const { result } = renderHook(() => useAutoBuzz(vi.fn().mockReturnValue(true)));

    // 2 本目（速い方）が online を書く
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.health).toBe('online');

    // 1 本目（遅い方）がタイムアウトして null を返す
    await act(async () => {
      releaseSlow(null);
    });

    expect(result.current.health).toBe('online');
  });
});
