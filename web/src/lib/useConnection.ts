/**
 * WebSocket 接続と再接続。出題者用・回答者用の両方が使う。
 *
 * サーバは状態を差分ではなく room_state として丸ごと送ってくるため、
 * 再接続時の復元は「繋ぎ直して次の room_state を受け取る」だけで済む。
 * ここに復元用のロジックは要らない。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from '../protocol';

/** 再接続の待ち時間。上限まで倍々にする */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000] as const;

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'ended';

type Options = {
  role?: 'host';
  /** 接続が確立したとき。join / host_hello を送るために使う */
  onOpen?: (send: (message: ClientMessage) => void) => void;
  onMessage?: (message: ServerMessage) => void;
};

function socketUrl(role?: 'host'): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams(window.location.search);
  query.delete('token');
  if (role) query.set('role', role);
  return `${protocol}//${window.location.host}/ws?${query}`;
}

export function useConnection({ onOpen, onMessage, role }: Options) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  // 再接続のたびにコールバックを購読し直さずに済むよう ref に保持する
  const onOpenRef = useRef(onOpen);
  const onMessageRef = useRef(onMessage);
  onOpenRef.current = onOpen;
  onMessageRef.current = onMessage;

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    // この effect が破棄されたか。ref ではなく effect ローカルに持つ。
    // StrictMode では 2 回目の effect が 1 回目のクリーンアップより先に
    // 走ることがあり、ref だと互いの状態を踏み合う。
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(socketUrl(role));
      socketRef.current = socket;
      setStatus('connecting');

      socket.addEventListener('open', () => {
        attemptRef.current = 0;
        setStatus('open');
        onOpenRef.current?.(send);
      });

      socket.addEventListener('message', (event: MessageEvent<string>) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          console.warn('[ws] 受け取ったメッセージを解釈できませんでした', event.data);
          return;
        }
        onMessageRef.current?.(message);
      });

      socket.addEventListener('close', (event: CloseEvent) => {
        // 破棄済みの接続の後始末では、状態も再接続も触らない。
        // StrictMode は effect を 2 回走らせるため、1 回目の接続が
        // ここへ来た時点で 2 回目の接続が既に生きている。
        if (disposed || socketRef.current !== socket) return;

        if (event.code === 4403 || event.code === 4404) {
          setStatus('ended');
          onMessageRef.current?.({ type: 'error', code: event.code === 4404 ? 'ended' : 'forbidden',
            message: event.code === 4404 ? '大会は終了しました。' : '参加URLまたは主催者認証が無効です。' });
          return;
        }
        setStatus('closed');

        // 会場では一時的に切れることが普通に起きるので、諦めずに繋ぎ直す
        const index = Math.min(attemptRef.current, RECONNECT_DELAYS_MS.length - 1);
        const delay = RECONNECT_DELAYS_MS[index] ?? 5000;
        attemptRef.current += 1;
        timerRef.current = window.setTimeout(connect, delay);
      });

      socket.addEventListener('error', () => {
        // close も続けて発火するので、ここでは再接続を仕掛けない
        if (socket.readyState === WebSocket.OPEN) socket.close();
      });
    };

    connect();

    return () => {
      disposed = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);

      const socket = socketRef.current;
      socketRef.current = null;
      // まだ CONNECTING のうちに close() すると "closed before established" に
      // なるので、開くのを待ってから閉じる
      if (socket?.readyState === WebSocket.CONNECTING) {
        socket.addEventListener('open', () => socket.close());
      } else {
        socket?.close();
      }
    };
  }, [send, role]);

  return { status, send };
}
