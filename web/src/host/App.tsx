/**
 * 出題者用の画面。スクリーン投影を想定している。
 *
 * この画面だけが音声を鳴らす。回答者の端末は無音。
 * 出題者の操作が起点になるので、ブラウザの自動再生ポリシーにも掛からない。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { alignmentDuration, visibleLength } from '../lib/align';
import { playJingle } from '../lib/sound';
import { useConnection } from '../lib/useConnection';
import { AiAnswerView } from './AiAnswerView';
import { AiPanel } from './AiPanel';
import { useAiPlayer } from './useAiPlayer';
import type { ClientMessage, RoomStateMessage, ServerMessage } from '../protocol';
import { Controls } from './Controls';
import { JoinPanel } from './JoinPanel';
import { PlayerList } from './PlayerList';
import { QuestionView } from './QuestionView';
import { useQuestion } from './useQuestion';

/** URL の ?token= から出題者用トークンを取る */
function hostTokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

export function App() {
  const [state, setState] = useState<RoomStateMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 音声の再生位置。requestAnimationFrame で更新し、文字送りを駆動する */
  const [currentTime, setCurrentTime] = useState(0);
  /** 早押し・読み切りで確定した表示文字数。null なら再生位置に追従する */
  const [frozenLength, setFrozenLength] = useState<number | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const hostToken = useRef(hostTokenFromUrl());

  /**
   * 音声なし問題の時計。
   *
   * <audio> が無いので currentTime を持てない。performance.now() を基準に、
   * 「開始時刻」と「停止時点までの経過秒」から現在位置を求める。
   * startedAt が null の間は止まっている（お手つき解除で再開できるよう、
   * 経過秒は保持したままにする）。
   */
  const silentClockRef = useRef<{ startedAt: number | null; elapsed: number }>({
    startedAt: null,
    elapsed: 0,
  });

  const question = useQuestion(state?.question ?? null);

  // 停止処理から参照するため、最新値を ref に持つ
  const questionRef = useRef(question);
  questionRef.current = question;
  /** ジングル中に押されたかどうか。await を跨いで再生を止めるために使う */
  const frozenRef = useRef(false);

  const stopTracking = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  /**
   * 現在の再生位置（秒）。音声の有無で供給元が変わる。
   *
   * rAF 追跡・freeze()・読み切り判定はすべてこれを経由する。
   * 音声ありは <audio> の currentTime、音声なしは performance.now() 基準の経過秒。
   */
  const currentPosition = useCallback((): number => {
    const loaded = questionRef.current;
    if (loaded !== null && loaded.audioUrl === null) {
      const clock = silentClockRef.current;
      if (clock.startedAt === null) return clock.elapsed;
      return clock.elapsed + (performance.now() - clock.startedAt) / 1000;
    }
    return audioRef.current?.currentTime ?? 0;
  }, []);

  /** 音声なしの時計を先頭から動かす */
  const startSilentClock = useCallback(() => {
    silentClockRef.current = { startedAt: performance.now(), elapsed: 0 };
  }, []);

  /** 音声なしの時計を止める。経過秒は保持し、続きから再開できるようにする */
  const pauseSilentClock = useCallback(() => {
    const clock = silentClockRef.current;
    if (clock.startedAt === null) return;
    clock.elapsed += (performance.now() - clock.startedAt) / 1000;
    clock.startedAt = null;
  }, []);

  /** 音声なしの時計を、止めた位置から再開する */
  const resumeSilentClock = useCallback(() => {
    const clock = silentClockRef.current;
    if (clock.startedAt !== null) return;
    clock.startedAt = performance.now();
  }, []);

  /** 音声と文字送りをその場で止める */
  const freeze = useCallback(() => {
    const audio = audioRef.current;
    const loaded = questionRef.current;
    frozenRef.current = true;
    audio?.pause();
    pauseSilentClock();
    stopTracking();

    if (loaded === null) return;
    setFrozenLength(visibleLength(loaded.alignment, currentPosition()));
  }, [stopTracking, pauseSilentClock, currentPosition]);

  /** AI の判定停止。handleMessage から呼ぶため ref で持つ */
  const aiStopRef = useRef<() => void>(() => {});

  const handleOpen = useCallback((send: (message: ClientMessage) => void) => {
    send({ type: 'host_hello', host_token: hostToken.current });
  }, []);

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case 'room_state':
          setState(message);
          break;

        case 'buzz_accepted':
          // 誰かが押した。問題文と音声をその場で止める。
          // 押したフィードバックなので、鳴り終わりは待たない
          freeze();
          void playJingle('buzz');
          // 人間が先に押した場合も含め、以降このラウンドでは判定しない
          aiStopRef.current();
          break;

        case 'error':
          setError(message.message);
          break;
      }
    },
    [freeze],
  );

  const { status, send } = useConnection({ onOpen: handleOpen, onMessage: handleMessage });

  const phase = state?.phase ?? 'idle';
  const roundId = state?.round_id ?? 0;

  const ai = useAiPlayer({ send, roundId, questionId: state?.question?.id ?? null });

  /** 回答権を得ているのが AI か。AI の回答枠を出すかの判断に使う */
  const buzzedIsAi =
    state?.buzzed != null &&
    state.players.some((player) => player.id === state.buzzed?.player_id && player.is_ai);
  aiStopRef.current = ai.stop;

  /** AI の参加を切り替える。参加させる側だけサーバへ登録を送る */
  const handleToggleAi = useCallback(
    (next: boolean) => {
      ai.setEnabled(next);
      // 参加を外しても Player は消さない。投影の一覧から名前が消えると、
      // 途中まで居た AI の戦績が追えなくなる（人間の切断と同じ扱い）
      if (next) send({ type: 'ai_join', name: 'AI' });
    },
    [ai, send],
  );

  // 新しい問題が読み込まれたら、ジングルを鳴らしてから読み上げを始める
  const questionId = question?.id ?? null;
  useEffect(() => {
    if (question === null || phase !== 'reading') return;

    const silent = question.audioUrl === null;
    const audio = audioRef.current;
    // 音声あり問題で <audio> がまだ無いなら、次のレンダリングを待つ。
    // 音声なしでは要素自体を描画しないので、null でも進める
    if (!silent && audio === null) return;

    let cancelled = false;

    // 前問で確定した表示文字数はここで捨てる。ジングルの再生完了を待ってから
    // 捨てると、その間ずっと前問の文字数で固定されたままになり、
    // 読み上げが始まっても文字送りが動かない。
    if (audio !== null) audio.currentTime = 0;
    setCurrentTime(0);
    setFrozenLength(null);
    frozenRef.current = false;
    silentClockRef.current = { startedAt: null, elapsed: 0 };

    void (async () => {
      // ジングルは音声の有無に関わらず鳴らす。問題の読み上げ音声とは別物で、
      // 早押しのフィードバックとして要るため
      await playJingle('set');
      // ジングルの間に押されていたら始めない。
      // サーバは start_question の時点で早押しを受け付けている
      if (cancelled || frozenRef.current) return;

      if (silent) {
        startSilentClock();
        return;
      }
      if (audio === null) return;

      audio.currentTime = 0;
      await audio.play().catch((reason: unknown) => {
        console.warn('[host] 問題音声を再生できませんでした', reason);
      });
    })();

    return () => {
      cancelled = true;
    };
    // ラウンドが変われば鳴らし直す。phase の往復（お手つき解除）では鳴らさない。
    // questionId だけを見ていると、同じ問題を続けて出したときに再生位置が
    // 前回の終端のままになり、即座に読み切り扱いになる。
    // questionId も依存に残すのは、出題直後はまだ .lab の取得中で
    // question が null のことがあり、その回の effect は何もせず抜けるため。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundId, questionId, startSilentClock]);

  // reading の間だけ再生位置を追い続ける
  useEffect(() => {
    if (phase !== 'reading' || question === null) return;

    const audio = audioRef.current;

    const silent = question.audioUrl === null;
    const duration = alignmentDuration(question.alignment);

    const tick = () => {
      const at = currentPosition();
      setCurrentTime(at);

      // 音声なしは <audio> の ended が無いので、終端到達を自分で見る
      if (silent && duration > 0 && at >= duration) {
        stopTracking();
        pauseSilentClock();
        setFrozenLength([...question.text].length);
        send({ type: 'reading_ended', round_id: roundId });
        return;
      }

      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    // 投影用のタブが背面に回るとブラウザが rAF を止め、文字送りだけが
    // 凍りつく（音声は鳴り続ける）。timeupdate は止まらないので保険に使う。
    // 精度は rAF に劣るが、表示が置き去りになるよりはよい。
    const handleTimeUpdate = () => {
      if (document.visibilityState === 'visible') return;
      const current = audioRef.current;
      if (current !== null) setCurrentTime(current.currentTime);
    };
    audio?.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      stopTracking();
      audio?.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [
    phase,
    question,
    roundId,
    send,
    stopTracking,
    currentPosition,
    pauseSilentClock,
  ]);

  /** お手つき解除で reading へ戻ったら、続きから再生する */
  useEffect(() => {
    if (phase !== 'reading') return;
    if (frozenLength === null) return;

    const loaded = questionRef.current;
    if (loaded !== null && loaded.audioUrl === null) {
      // 時計を先に動かしてから frozenLength を外す。順序が逆だと、
      // 追跡が再開するまでの 1 フレーム、currentTime が前問の値
      // （出題時に 0 へ戻したまま）で描画され、表示が一瞬巻き戻る。
      resumeSilentClock();
      setCurrentTime(currentPosition());
      setFrozenLength(null);
      return;
    }

    const audio = audioRef.current;
    if (audio === null || audio.paused === false) return;

    setFrozenLength(null);
    void audio.play().catch(() => undefined);
    // 解除のときだけ動かしたいので frozenLength は依存に含めない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, roundId, resumeSilentClock, currentPosition]);

  /** 押されないまま読み切った */
  const handleAudioEnded = useCallback(() => {
    if (question === null) return;
    stopTracking();
    setFrozenLength([...question.text].length);
    send({ type: 'reading_ended', round_id: roundId });
  }, [question, roundId, send, stopTracking]);

  const handleStart = useCallback(() => {
    setError(null);
    send({ type: 'start_question' });
  }, [send]);

  const handleTimeUp = useCallback(() => {
    send({ type: 'time_up', round_id: roundId });
  }, [roundId, send]);

  const handleCheck = useCallback(() => {
    send({ type: 'check', round_id: roundId });
  }, [roundId, send]);

  const handleJudge = useCallback(
    (correct: boolean) => {
      send({ type: 'judge', round_id: roundId, correct });
      void playJingle(correct ? 'correct' : 'wrong');
    },
    [roundId, send],
  );

  const handleRelease = useCallback(() => {
    send({ type: 'release', round_id: roundId });
  }, [roundId, send]);

  const handleNext = useCallback(() => {
    send({ type: 'next' });
  }, [send]);

  // 表示中の文字数。停止後は frozenLength で固定する
  const hasAlignment = question !== null && question.alignment.chunks.length > 0;
  const shownLength =
    question === null
      ? 0
      : (frozenLength ??
        (hasAlignment ? visibleLength(question.alignment, currentTime) : [...question.text].length));

  // ラウンドが変わったら AI の判定状態を捨てる
  useEffect(() => {
    ai.reset();
    // reset は安定した参照なので、ラウンドの変化だけで走らせる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundId]);

  // 読み上げ中、表示文字数が変わるたびに Jev へ判定を投げる。
  // 時間ではなく文字数の変化で駆動するのは、無音区間や長音で同じ文字列を
  // 繰り返し投げないため。送信の間引きは useAiPlayer が行う。
  useEffect(() => {
    if (phase !== 'reading' || question === null) return;

    // **今の問題が今のラウンドのものかを確かめる。**
    // 新しいラウンドが始まった直後は、phase と roundId だけが先に更新され、
    // question は前問のまま残る（useQuestion が .lab を非同期で取りに行く）。
    if (state?.question?.id !== question.id) return;

    // **AI に渡す文字数は shownLength から取らない。**
    // shownLength は投影の都合を含んでいる:
    //   - frozenLength … 前ラウンドの停止位置が、リセットされるまで残る
    //   - hasAlignment が false … .lab を読めないときは「全文」を出す
    // どちらも「読み上げがそこまで進んだ」という意味ではないため、そのまま
    // 渡すと開始直後に全文が飛び、AI がカンニングしたように即座に押す。
    //
    // 判定には再生位置から都度求めた値だけを使う。アライメントが無い間は
    // 進捗が分からないので、判定そのものを見送る。
    if (!hasAlignment) return;

    // **実際に読み上げが始まっているかを、再生の実体で確かめる。**
    // currentTime も frozenLength も「前ラウンドの値が残っている」窓がある
    // （どちらも問題の読み込み完了を待つ effect の中でリセットされるため）。
    // <audio> が再生中か、音声なし問題の時計が動いているかだけが、
    // 「今この問題の読み上げが進んでいる」ことの確かな根拠になる。
    const audio = audioRef.current;
    const silent = question.audioUrl === null;
    const playing = silent
      ? silentClockRef.current.startedAt !== null
      : audio !== null && !audio.paused;
    if (!playing) return;

    // 表示用の値ではなく、再生位置から都度求めた値を使う
    const heard = visibleLength(question.alignment, currentPosition());
    if (heard === 0) return;

    ai.feed([...question.text].slice(0, heard).join(''), heard, question.id);
    // ai 全体を依存に置くと毎フレーム実行される。必要なのは feed だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, question, currentTime, hasAlignment, currentPosition, state?.question?.id, ai.feed]);

  // 読み切った後も早押しは締め切られない（締め切るのは出題者の time_up）。
  // 人間はこの間も押せるので、AI も押せないと対決として不公平になる。
  //
  // ただし即座に押させない。読み切りの直後は人間が考えている時間であり、
  // そこへ AI が割り込むと考える間が無くなる。待ち時間は
  // AI_READING_ENDED_DELAY_MS で変えられる（0 なら読み切りと同時）。
  useEffect(() => {
    if (phase !== 'readingEnded' || question === null) return;
    if (state?.question?.id !== question.id) return;

    const timer = window.setTimeout(() => {
      // 読み切っているので全文を渡す。まだ読まれていない部分は無く、
      // 人間が聞いた範囲と同じであるため、カンニングにはあたらない
      const text = question.text;
      // force。読み上げ中に全文まで送っていると間引かれてしまう
      ai.feed(text, [...text].length, question.id, true);
    }, ai.readiness.readingEndedDelayMs);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, question, state?.question?.id, ai.feed, ai.readiness.readingEndedDelayMs]);

  if (hostToken.current === '') {
    return (
      <main className="host">
        <p className="host-error">
          出題者用トークンがありません。サーバ起動時に表示された URL を開いてください。
        </p>
      </main>
    );
  }

  return (
    <main className="host">
      {question !== null && question.audioUrl !== null && (
        <audio
          ref={audioRef}
          src={question.audioUrl}
          onEnded={handleAudioEnded}
          preload="auto"
        />
      )}

      <section className="host-stage">
        {state?.buzzed != null ? (
          <div className="buzzed-banner" aria-live="assertive">
            <span className="buzzed-name">{state.buzzed.name}</span>
          </div>
        ) : null}

        <QuestionView
          text={question === null ? '' : [...question.text].slice(0, shownLength).join('')}
          // 全文を見せるのは、もう早押しを受け付けない段になってから
          fullText={
            phase === 'check' || phase === 'timeUp' || phase === 'result'
              ? (question?.text ?? '')
              : null
          }
          // 正解を出してよい phase かどうかはサーバが決める。
          // 送られてこない phase では answers が null になっている。
          // useQuestion は .lab の取得結果をキャッシュしていて phase の変化に
          // 追従しないので、room_state から直接読む
          answers={state?.question?.answers ?? null}
          judgement={state?.judgement ?? null}
        />

        {/* 正解と同じ phase でのみサーバが載せてくる */}
        {/* AI が押していれば、合議が固まる前から枠を出す。
            正解より早く出してよい理由は room.py の AI_ANSWER_VISIBLE_PHASES を参照 */}
        {buzzedIsAi && (
          <AiAnswerView
            answer={state?.ai_answer ?? null}
            pending={state?.ai_answer == null}
          />
        )}
      </section>

      <aside className="host-side">
        <JoinPanel />
        <PlayerList players={state?.players ?? []} buzzedId={state?.buzzed?.player_id ?? null} />

        <AiPanel
          enabled={ai.enabled}
          readiness={ai.readiness}
          lastJudgement={ai.lastJudgement}
          disabled={phase !== 'idle' && phase !== 'result'}
          onToggle={handleToggleAi}
          onRefresh={() => void ai.refresh()}
        />
      </aside>

      <footer className="host-controls">
        <Controls
          phase={phase}
          connected={status === 'open'}
          onStart={handleStart}
          onTimeUp={handleTimeUp}
          onCheck={handleCheck}
          onJudge={handleJudge}
          onRelease={handleRelease}
          onNext={handleNext}
        />
        {error !== null && <p className="host-error">{error}</p>}
      </footer>

      {/* 残り問題数。出題者が把握できればよいので、投影の邪魔にならない大きさで隅に置く */}
      {state !== null && state.total_questions > 0 && (
        <p className="host-remaining">
          残り {state.remaining_questions} / {state.total_questions}
        </p>
      )}
    </main>
  );
}
