import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as judgeApi from './judge';
import { useSlotJudge } from './useSlotJudge';

const PRESS: judgeApi.JudgeResult = {
  status: 'ok',
  buzz: 0.95,
  parallel: 0.1,
  asking: 0.8,
  narrowed: 2.5,
  elapsedMs: 100,
};

const HOLD: judgeApi.JudgeResult = { ...PRESS, buzz: 0.1 };

describe('useSlotJudge', () => {
  beforeEach(() => {
    vi.spyOn(judgeApi, 'judge').mockResolvedValue(HOLD);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('世代が変わった後の応答では押さない', async () => {
    let release: (value: judgeApi.JudgeResult) => void = () => {};
    vi.spyOn(judgeApi, 'judge').mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useSlotJudge({
        provider: 'typesafe',
        active: true,
        totalLength: 20,
        currentLength: () => 12,
      }),
    );

    act(() => {
      result.current.feed('日本の小説家で', 10);
    });
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      release(PRESS);
    });

    await waitFor(() => {
      expect(result.current.state.display?.pressed).not.toBe(true);
    });
  });

  it('基準位置で残りがあれば押した扱いにし白と灰を残す', async () => {
    vi.spyOn(judgeApi, 'judge').mockResolvedValue(PRESS);
    let arrived = 12;
    const { result } = renderHook(() =>
      useSlotJudge({
        provider: 'openai',
        active: true,
        totalLength: 20,
        currentLength: () => arrived,
      }),
    );

    act(() => {
      result.current.feed('日本の小説家で', 10);
    });

    await waitFor(() => {
      expect(result.current.state.display?.pressed).toBe(true);
    });
    expect(result.current.state.display?.whiteLength).toBe(10);
    expect(result.current.state.display?.grayLength).toBe(12);

    // 読み切り後に届いても、すでに押していればそのまま
    arrived = 20;
  });

  it('基準位置が全文なら押さない', async () => {
    vi.spyOn(judgeApi, 'judge').mockResolvedValue(PRESS);
    const { result } = renderHook(() =>
      useSlotJudge({
        provider: 'gemini',
        active: true,
        totalLength: 10,
        currentLength: () => 10,
      }),
    );

    act(() => {
      result.current.feed('abcdefghij', 10);
    });

    await waitFor(() => {
      expect(result.current.state.judgement).not.toBeNull();
    });
    expect(result.current.state.display?.pressed).not.toBe(true);
  });
});
