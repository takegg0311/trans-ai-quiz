import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useConnection } from './useConnection';

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) { super(); FakeSocket.instances.push(this); }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); FakeSocket.instances = []; });

it('期限切れの切断では再接続せず終了を通知する', () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  const onMessage = vi.fn();
  const { result } = renderHook(() => useConnection({ onMessage, role: 'host' }));
  const ws = FakeSocket.instances[0]!;
  expect(ws.url).toContain('role=host');
  act(() => { ws.dispatchEvent(new CloseEvent('close', { code: 4404 })); });
  act(() => { vi.advanceTimersByTime(10000); });
  expect(result.current.status).toBe('ended');
  expect(FakeSocket.instances).toHaveLength(1);
  expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ code: 'ended' }));
});

it('通常の切断では再接続する', () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  renderHook(() => useConnection({}));
  act(() => { FakeSocket.instances[0]!.dispatchEvent(new CloseEvent('close', { code: 1006 })); });
  act(() => { vi.advanceTimersByTime(500); });
  expect(FakeSocket.instances).toHaveLength(2);
});
