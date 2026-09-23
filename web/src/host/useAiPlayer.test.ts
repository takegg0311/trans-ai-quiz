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

/** 予測の成功応答を作る */
function answer(text: string, elapsedMs: number): llm.PredictResult {
  return { status: 'ok', continuation: null, answer: text, elapsedMs, raw: '' };
}

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
    readingEndedDelayMs: 0,
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

describe('遅れて届いたモデルの回答', () => {
  it('確定後に届いた応答でも送り直す', async () => {
    // 早期確定（2 モデル一致）で打ち切ると、3 モデル目が投影に
    // 「応答なし」のまま残ってしまう
    vi.spyOn(jev, 'judge').mockResolvedValue(PRESS);
    const resolvers: ((value: llm.PredictResult) => void)[] = [];
    vi.spyOn(llm, 'predict').mockImplementation(
      () =>
        new Promise<llm.PredictResult>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { hook, send } = await mount('q1');

    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });
    await waitFor(() => expect(resolvers).toHaveLength(OPPONENTS.length));

    // 2 モデルが一致して確定する
    await act(async () => {
      resolvers[0]?.(answer('富士山', 1000));
      resolvers[1]?.(answer('富士山', 1200));
    });

    const settled = send.mock.calls
      .map((call) => call[0])
      .filter((message) => message.type === 'ai_answer');
    expect(settled).toHaveLength(1);

    // 確定時点では 3 モデル目は「応答待ち」。失敗扱いにしない
    expect(settled[0].models[2]?.pending).toBe(true);
    expect(settled[0].models[2]?.error).toBeUndefined();

    // 3 モデル目が遅れて届く
    await act(async () => {
      resolvers[2]?.(answer('北岳', 5500));
    });

    const all = send.mock.calls
      .map((call) => call[0])
      .filter((message) => message.type === 'ai_answer');
    expect(all).toHaveLength(2);

    const last = all[1];
    // 合議の結果は変わらない
    expect(last.answer).toBe('富士山');
    // 3 モデル目の回答が入り、応答待ちが解ける
    expect(last.models[2]?.answer).toBe('北岳');
    expect(last.models[2]?.error).toBeUndefined();
    expect(last.models[2]?.pending).toBeUndefined();
  });

  it('タイムアウトは応答待ちではなく失敗として出す', async () => {
    // 待っても来ないものは「応答なし」でよい。区別するのは未着だけ
    vi.spyOn(jev, 'judge').mockResolvedValue(PRESS);
    const resolvers: ((value: llm.PredictResult) => void)[] = [];
    vi.spyOn(llm, 'predict').mockImplementation(
      () =>
        new Promise<llm.PredictResult>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { hook, send } = await mount('q1');

    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });
    await waitFor(() => expect(resolvers).toHaveLength(OPPONENTS.length));

    await act(async () => {
      resolvers[0]?.(answer('富士山', 1000));
      resolvers[1]?.(answer('富士山', 1200));
      resolvers[2]?.({
        status: 'error',
        kind: 'timeout',
        message: '応答がありませんでした',
        elapsedMs: 60000,
      });
    });

    const all = send.mock.calls
      .map((call) => call[0])
      .filter((message) => message.type === 'ai_answer');
    const last = all[all.length - 1];

    expect(last.models[2]?.pending).toBeUndefined();
    expect(last.models[2]?.error).toBe('応答がありませんでした');
  });

  it('確定前の応答では送らない', async () => {
    vi.spyOn(jev, 'judge').mockResolvedValue(PRESS);
    const resolvers: ((value: llm.PredictResult) => void)[] = [];
    vi.spyOn(llm, 'predict').mockImplementation(
      () =>
        new Promise<llm.PredictResult>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { hook, send } = await mount('q1');

    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });
    await waitFor(() => expect(resolvers).toHaveLength(OPPONENTS.length));

    // 1 モデルだけでは多数決が決まらない
    await act(async () => {
      resolvers[0]?.(answer('富士山', 1000));
    });

    const sent = send.mock.calls
      .map((call) => call[0])
      .filter((message) => message.type === 'ai_answer');
    expect(sent).toHaveLength(0);
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

  it('force なら同じ文字数でも送る', async () => {
    // 読み切り後の 1 回。読み上げ中に全文まで送り切っていると、
    // 間引かれて「読み切り後の判定」が一度も走らない
    const judge = vi.spyOn(jev, 'judge').mockResolvedValue(HOLD);
    const { hook } = await mount('q1');

    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });
    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1', true);
    });

    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('force でも押した後は送らない', async () => {
    // 既に押していれば、読み切り後に送り直す意味が無い
    const judge = vi.spyOn(jev, 'judge').mockResolvedValue(PRESS);
    const { hook } = await mount('q1');

    await act(async () => {
      hook.result.current.feed(TEXT, 40, 'q1');
    });
    await act(async () => {
      hook.result.current.feed(TEXT, 41, 'q1', true);
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
