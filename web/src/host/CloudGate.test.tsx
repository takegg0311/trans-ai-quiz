import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudGate, TournamentSettings } from './CloudGate';

vi.mock('./App', () => ({ App: ({ cloud }: { cloud?: boolean }) => <div>{cloud ? 'クラウド出題者' : 'ローカル出題者'}</div> }));
const fetchMock = vi.fn();
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); fetchMock.mockReset(); });

describe('開催入口', () => {
  it('ローカル版は従来の出題者画面を開く', async () => {
    fetchMock.mockResolvedValue(response({}, 404));
    render(<CloudGate />);
    expect(await screen.findByText('ローカル出題者')).toBeTruthy();
  });
  it('開催中はZIPなしで認証して復帰する', async () => {
    fetchMock.mockResolvedValueOnce(response({ cloud: true }))
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ active: true }));
    render(<CloudGate />);
    fireEvent.change(await screen.findByLabelText('主催者パスワード'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByText('認証して開始・復帰'));
    expect(await screen.findByText('クラウド出題者')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('X-Quiz-Request')).toBe('1');
  });
  it('新規開催のZIP検証失敗を表示して出題画面へ進めない', async () => {
    fetchMock.mockResolvedValueOnce(response({ cloud: true }))
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ active: false }))
      .mockResolvedValueOnce(response({ detail: '音声ファイルが不足しています' }, 422));
    render(<CloudGate />);
    fireEvent.change(await screen.findByLabelText('主催者パスワード'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('問題データ（ZIP、24 MiB以下）'), {
      target: { files: [new File(['zip'], 'questions.zip')] },
    });
    fireEvent.click(screen.getByText('認証して開始・復帰'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '音声ファイルが不足しています');
    expect(screen.queryByText('クラウド出題者')).toBeNull();
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/tournament');
  });
  it('大会の終了には確認操作が必要', async () => {
    fetchMock.mockResolvedValueOnce(response({ expires_at: 1800000000 }))
      .mockResolvedValueOnce(response({ ended: true }));
    const ended = vi.fn();
    render(<TournamentSettings onEnded={ended} />);
    fireEvent.click(screen.getByText('大会設定'));
    fireEvent.click(screen.getByText('大会を終了…'));
    expect(ended).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('大会を終了する（確定）'));
    await waitFor(() => expect(ended).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/tournament/end');
  });
});
