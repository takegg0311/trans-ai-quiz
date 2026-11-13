import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as judgeApi from './judge';
import { useProviderHealth } from './useProviderHealth';

const READY_HEALTH: judgeApi.JudgeHealth = {
  available: true,
  provider: 'typesafe',
  model: 'jev-latest',
  narrowedLevels: 4,
  readingEndedDelayMs: 5000,
  providers: [
    {
      id: 'typesafe',
      label: 'TypeSafe',
      model: 'jev-latest',
      available: true,
    },
    {
      id: 'openai',
      label: 'OpenAI',
      model: 'gpt-6-luna',
      available: false,
      reason: 'OPENAI_API_KEY が設定されていません',
    },
    {
      id: 'gemini',
      label: 'Gemini',
      model: 'gemini-decision-1',
      available: false,
      reason: 'GEMINI_API_KEY が設定されていません',
    },
  ],
};

describe('useProviderHealth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('health 取得前は出題できず、成功後は出題できる', async () => {
    let release: (value: judgeApi.JudgeHealth | null) => void = () => {};
    vi.spyOn(judgeApi, 'checkHealth').mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const { result } = renderHook(() => useProviderHealth());

    expect(result.current.status).toBe('checking');
    expect(result.current.canStart).toBe(false);

    await act(async () => {
      release(READY_HEALTH);
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.canStart).toBe(true);
  });

  it('health 取得に失敗したら offline で出題できない', async () => {
    let release: (value: judgeApi.JudgeHealth | null) => void = () => {};
    vi.spyOn(judgeApi, 'checkHealth').mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const { result } = renderHook(() => useProviderHealth());
    expect(result.current.canStart).toBe(false);

    await act(async () => {
      release(null);
    });

    await waitFor(() => {
      expect(result.current.status).toBe('offline');
    });
    expect(result.current.canStart).toBe(false);
  });
});
