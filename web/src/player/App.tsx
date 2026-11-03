/**
 * 回答者用の画面。早押しボタンと名前だけを持つ。
 *
 * 音声は鳴らさず、問題文も表示しない（サーバが送ってこない）。
 * 音声より先に問題文が読めてしまうと早押しの意味が無くなるため。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection } from '../lib/useConnection';
import { useWakeLock } from '../lib/useWakeLock';
import {
  describeRejectReason,
  type ClientMessage,
  type RoomStateMessage,
  type ServerMessage,
} from '../protocol';
import { BuzzButton } from './BuzzButton';
import { NameForm } from './NameForm';

/** リロードしても同じ参加者として復帰するために保存する */
const EVENT_ID = new URLSearchParams(window.location.search).get('event');
const TOKEN_KEY = `trans-ai-quiz.player-token${EVENT_ID ? `.${EVENT_ID}` : ''}`;
const NAME_KEY = 'trans-ai-quiz.player-name';

export function App() {
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const [joined, setJoined] = useState(() => localStorage.getItem(TOKEN_KEY) !== null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [state, setState] = useState<RoomStateMessage | null>(null);
  const [ended, setEnded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 送信直後の見た目を先に変えるため、サーバの応答を待たずに落とす
  const [pressed, setPressed] = useState(false);

  const nameRef = useRef(name);
  nameRef.current = name;

  const handleOpen = useCallback((send: (message: ClientMessage) => void) => {
    const token = localStorage.getItem(TOKEN_KEY);
    // token があれば名前入力を経ずに復帰できる
    if (token !== null || nameRef.current !== '') {
      send({ type: 'join', name: nameRef.current, token });
    }
  }, []);

  const handleMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case 'welcome':
        localStorage.setItem(TOKEN_KEY, message.token);
        localStorage.setItem(NAME_KEY, nameRef.current);
        setPlayerId(message.player_id);
        setJoined(true);
        break;

      case 'room_state':
        setState(message);
        break;

      case 'buzz_accepted':
        setPressed(false);
        setNotice(null);
        break;

      case 'buzz_rejected':
        setPressed(false);
        setNotice(describeRejectReason(message.reason));
        break;

      case 'error':
        if (message.code === 'ended' || message.code === 'forbidden') setEnded(true);
        setNotice(message.message);
        break;
    }
  }, []);

  const { status, send } = useConnection({ onOpen: handleOpen, onMessage: handleMessage });

  // 参加後は画面を消させない。ロックされると押せなくなる
  useWakeLock(joined);

  // ラウンドが変われば前問の通知は消す
  const roundId = state?.round_id;
  useEffect(() => {
    setNotice(null);
    setPressed(false);
  }, [roundId]);

  const handleSubmitName = useCallback(
    (input: string) => {
      setName(input);
      nameRef.current = input;
      send({ type: 'join', name: input, token: localStorage.getItem(TOKEN_KEY) });
    },
    [send],
  );

  const handleBuzz = useCallback(() => {
    if (state === null) return;
    setPressed(true);
    send({
      type: 'buzz',
      round_id: state.round_id,
      client_sent_at: Date.now(),
    });
  }, [send, state]);

  if (ended) return <main className="player"><p role="alert">{notice ?? '大会は終了しました。'}</p></main>;

  if (!joined) {
    return (
      <main className="player">
        <NameForm defaultValue={name} disabled={status !== 'open'} onSubmit={handleSubmitName} />
        {status !== 'open' && <p className="notice">サーバに接続しています…</p>}
      </main>
    );
  }

  const me = state?.players.find((player) => player.id === playerId) ?? null;
  const hasAnswerRight = state?.buzzed?.player_id === playerId;
  const canBuzz =
    status === 'open' &&
    state?.paused !== true &&
    state !== null &&
    // 読み切った後（readingEnded）も締め切られるまで押せる。
    // サーバ側の Room.buzz が受け付ける phase と揃えること
    (state.phase === 'reading' || state.phase === 'readingEnded') &&
    !pressed &&
    me?.locked_out !== true;

  return (
    <main className="player">
      <header className="player-header">
        <span className="player-name">{me?.name ?? name}</span>
        {status !== 'open' && <span className="player-status">接続中…</span>}
      </header>

      {/* 残り高さを占める領域の中央に置く。通知は外に出し、出てもボタン位置が大きく動かないようにする */}
      <div className="player-stage">
        {hasAnswerRight ? (
          <section className="answer-right" aria-live="assertive">
            <p className="answer-right-label">回答権</p>
            <p className="answer-right-note">答えを声で伝えてください</p>
          </section>
        ) : (
          <BuzzButton disabled={!canBuzz} onBuzz={handleBuzz} />
        )}
      </div>

      {state?.buzzed != null && !hasAnswerRight && (
        <p className="notice" aria-live="polite">
          {state.buzzed.name} さんが回答中
        </p>
      )}

      {me?.locked_out === true && state?.buzzed == null && (
        <p className="notice">この問題では、もう押せません</p>
      )}

      {notice !== null && <p className="notice">{notice}</p>}
    </main>
  );
}
