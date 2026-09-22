/**
 * AI 参加者の制御のテスト。
 *
 * 実機で「1 文字も進んでいないのに AI が回答権を得て、正解も当てる」という
 * 挙動が出た。原因は、新しいラウンドが始まった直後の 1 レンダリングで
 * **前問の本文が Jev へ渡っていた**こと。
 *
 * 新ラウンドでは phase と roundId が先に更新される一方、問題の読み込み
 * （.lab の非同期取得）が追いつかず、question と shownLength が前問のまま
 * 残る窓がある。前問は読み切られていることが多いので、ほぼ全文が渡って
 * 即座に押してしまう。カンニングしているように見える。
 *
 * ここで固定するのは「**判定に使った問題が今の問題と違えば押さない**」こと。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as jev from '../lib/jev';
import * as llm from '../lib/llm';
import type { ClientMessage } from '../protocol';
import { OPPONENTS, useAiPlayer } from './useAiPlayer';

/** 押すと判断される観測値 */
const PRESS: jev.JudgeResult = {
  status: 'ok',
  buzz: 0.95,
  parallel: 0.05,
  asking: 0.9,
  narrowed: 2.9,
  elapsedMs: 100,
};

/** 押さないと判断される観測値 */
const HOLD: jev.JudgeResult = { ...PRESS, buzz: 0.1 };

/** 危険区間を抜けた長さの文字列 */
const TEXT = 'あ'.repeat(40);

function providers(): llm.ProviderInfo[] {
  return OPPONENTS.map((opponent) => ({
    vendor: opponent.vendor,
    label: opponent.label,
    available: true,
    models: [opponent.model],
  }));
}

/** 疎通が済むまで待つ。これを待たないと feed が送らない */
async function mount(questionId: string | null, send = vi.fn()) {
  const hook = renderHook(
    ({ qid }: { qid: string | null }) =>
      useAiPlayer({ send: send as (message: ClientMessage) => void, roundId: 1, questionId: qid }),
    { initialProps: { qid: questionId } },
  );
  await waitFor(() => expect(hook.result.current.readiness.jev).toBe(true));
  act(() => {
    hook.result.current.setEnabled(true);
  });
  return { hook, send };
}

beforeEach(() => {
  vi.spyOn(jev, 'checkHealth').mockResolvedValue({
    available: true,
    model: 'jev-latest',
    narrowedLevels: 4,
  });
  vi.spyOn(llm, 'checkHealth').mockResolvedValue(providers());
  vi.spyOn(llm, 'predict').mockResolvedValue({
    status: 'ok',
    continuation: null,
    answer: '富士山',
    elapsedMs: 500,
    raw: '',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('前問の文章で押さない', () => {
  it('判定に使った問題が今の問題と違えば押さない', async () => {
    // 判定の応答が返るまでの間に、サーバが次の問題へ進んだ場合
    let release: (value: jev.JudgeResult) => void = () => {};
    vi.spyOn(jev, 'judge').mockReturnValue(
      new Promise<jev.JudgeResult>((resolve) => {
        release = resolve;
      }),
    );
    const { hook, send } = await mount('q1');

    act(() => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });

    // 判定中に次の問題へ切り替わる
    hook.rerender({ qid: 'q2' });
    await act(async () => {
      release(PRESS);
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('同じ問題なら押す', async () => {
    vi.spyOn(jev, 'judge').mockResolvedValue(PRESS);
    const { hook, send } = await mount('q1');

    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ai_buzz', judged_length: 40 }),
      ),
    );
  });

  it('押さなかった場合、合議も走らない', async () => {
    let release: (value: jev.JudgeResult) => void = () => {};
    vi.spyOn(jev, 'judge').mockReturnValue(
      new Promise<jev.JudgeResult>((resolve) => {
        release = resolve;
      }),
    );
    const predict = vi.spyOn(llm, 'predict');
    const { hook } = await mount('q1');

    act(() => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });
    hook.rerender({ qid: 'q2' });
    await act(async () => {
      release(PRESS);
    });

    expect(predict).not.toHaveBeenCalled();
  });
});

describe('自動のオン / オフ', () => {
  it('オフの間は送信しない', async () => {
    const judge = vi.spyOn(jev, 'judge').mockResolvedValue(HOLD);
    const { hook } = await mount('q1');

    act(() => {
      hook.result.current.setEnabled(false);
    });
    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });

    expect(judge).not.toHaveBeenCalled();
  });

  it('送信後にオフへ切り替えたら押さない', async () => {
    let release: (value: jev.JudgeResult) => void = () => {};
    vi.spyOn(jev, 'judge').mockReturnValue(
      new Promise<jev.JudgeResult>((resolve) => {
        release = resolve;
      }),
    );
    const { hook, send } = await mount('q1');

    act(() => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });
    act(() => {
      hook.result.current.setEnabled(false);
    });
    await act(async () => {
      release(PRESS);
    });

    expect(send).not.toHaveBeenCalled();
  });
});

describe('送信の間引き', () => {
  it('同じ文字数では送らない', async () => {
    const judge = vi.spyOn(jev, 'judge').mockResolvedValue(HOLD);
    const { hook } = await mount('q1');

    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });
    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });

    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('応答待ちの間は送らない', async () => {
    const judge = vi.spyOn(jev, 'judge').mockReturnValue(
      new Promise<jev.JudgeResult>(() => {
        // 返さない
      }),
    );
    const { hook } = await mount('q1');

    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });
    await act(async () => {
      hook.result.current.feed(TEXT, 41, 'q1');
    });

    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('押した後は送らない', async () => {
    const judge = vi.spyOn(jev, 'judge').mockResolvedValue(PRESS);
    const { hook } = await mount('q1');

    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });
    await act(async () => {
      hook.result.current.feed(TEXT, 41, 'q1');
    });

    expect(judge).toHaveBeenCalledTimes(1);
  });
});

describe('stop', () => {
  it('人間が先に押した後は送らない', async () => {
    const judge = vi.spyOn(jev, 'judge').mockResolvedValue(HOLD);
    const { hook } = await mount('q1');

    act(() => {
      hook.result.current.stop();
    });
    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });

    expect(judge).not.toHaveBeenCalled();
  });
});
