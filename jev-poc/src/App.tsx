import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { visibleLength } from './lib/align';
import { formatAnswer, isCorrect } from './lib/answer';
import {
  loadManifest,
  loadQuestion,
  pickRandom,
  type ManifestEntry,
} from './lib/manifest';
import { playJingle } from './lib/sound';
import { useAiAnswer } from './lib/useAiAnswer';
import { useAutoBuzz } from './lib/useAutoBuzz';
import {
  canAnswer,
  canBuzz,
  initialState,
  quizReducer,
} from './state/quizMachine';
import { AiAnswerView } from './components/AiAnswerView';
import { AnswerInput } from './components/AnswerInput';
import { BuzzButton } from './components/BuzzButton';
import { JevPanel } from './components/JevPanel';
import { QuestionView } from './components/QuestionView';
import { ResultView } from './components/ResultView';
import { StartScreen } from './components/StartScreen';

export function App() {
  const [state, dispatch] = useReducer(quizReducer, initialState);
  const [entries, setEntries] = useState<ManifestEntry[]>([]);
  /** 音声の再生位置。requestAnimationFrame で更新し、文字送りを駆動する */
  const [currentTime, setCurrentTime] = useState(0);
  /** 自動で押した場合に、その理由を結果画面まで残す */
  const [pressedReason, setPressedReason] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const frameRef = useRef<number | null>(null);
  /** 直前に出題した問題。同じ問題が連続しないようにするため */
  const lastIdRef = useRef<string | undefined>(undefined);
  /** 早押し処理。自動側から呼ぶため ref で最新を持つ */
  const buzzRef = useRef<(chars: number, reason: string) => boolean>(() => false);
  /** 自動判定の停止。handleBuzz から呼ぶため ref で持つ */
  const autoStopRef = useRef<() => void>(() => {});
  /**
   * 次に reading へ入るのが「再開」かどうか。
   *
   * AI が誤答して人間へ解答権が移る場合、読み上げは止めた位置から続ける。
   * phase だけでは「最初から」と「再開」を区別できないため、ここで持つ。
   */
  const resumeRef = useRef(false);

  const { phase, question, frozenLength, judgedLength, judgement, aiAttempt, error } = state;

  /** Jev が押すと判断したときに呼ばれる。受理したかを返す */
  const handleAutoPress = useCallback(
    (chars: number, reason: string) => buzzRef.current(chars, reason),
    [],
  );

  const auto = useAutoBuzz(handleAutoPress);
  autoStopRef.current = auto.stop;

  const ai = useAiAnswer();

  // 起動時に問題一覧を読み込む
  useEffect(() => {
    let cancelled = false;
    loadManifest()
      .then((loaded) => {
        if (cancelled) return;
        if (loaded.length === 0) {
          dispatch({
            type: 'loadFailed',
            message:
              '問題が 1 問もありません。public/quiz_data に wav / txt / lab の 3 点セットを配置してください。',
          });
          return;
        }
        setEntries(loaded);
        dispatch({ type: 'ready' });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        dispatch({
          type: 'loadFailed',
          message: reason instanceof Error ? reason.message : String(reason),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 表示中の文字数。早押し後は frozenLength で固定する
  const shownLength =
    question === null
      ? 0
      : (frozenLength ?? visibleLength(question.alignment, currentTime));
  const shownText =
    question === null ? '' : [...question.text].slice(0, shownLength).join('');

  /** 再生位置の監視を止める */
  const stopTracking = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  // reading の間だけ再生位置を追い続ける
  useEffect(() => {
    if (phase !== 'reading') return;

    const audio = audioRef.current;
    if (audio === null) return;

    // AI の誤答で reading へ戻った場合は、止めた位置から再開する。
    // 先頭へ巻き戻すと問題文を最初から読み直すことになり、
    // AI が押した意味が無くなる（人間が全文を聞けてしまう）。
    if (!resumeRef.current) {
      audio.currentTime = 0;
      setCurrentTime(0);
    }
    resumeRef.current = false;

    void audio.play().catch((reason: unknown) => {
      console.warn('[audio] 問題音声を再生できませんでした', reason);
    });

    const tick = () => {
      const current = audioRef.current;
      if (current !== null) setCurrentTime(current.currentTime);
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    return stopTracking;
  }, [phase, stopTracking]);

  // 読み上げ中、表示文字数が変わるたびに Jev へ判定を投げる。
  // 時間ではなく文字数の変化で駆動するのは、無音区間や長音で同じ文字列を
  // 繰り返し投げないため。送信の間引きは useAutoBuzz が行う。
  useEffect(() => {
    if (phase !== 'reading' || question === null) return;
    if (shownLength === 0) return;
    auto.feed([...question.text].slice(0, shownLength).join(''), shownLength);
    // auto 全体を依存に置くと、戻り値が毎レンダー新しい参照になるため
    // 読み上げ中は毎フレーム実行される。必要なのは feed だけ。
  }, [phase, question, shownLength, auto.feed]);

  /** 出題を始める。ジングルを鳴らし切ってから問題音声へ入る */
  const startQuestion = useCallback(async () => {
    const entry = pickRandom(entries, lastIdRef.current);
    if (entry === undefined) return;

    // データ読み込みを待つ間、前問の結果を残したままにしない
    dispatch({ type: 'next' });
    auto.reset();
    ai.reset();
    setPressedReason(null);

    try {
      const loaded = await loadQuestion(entry);
      lastIdRef.current = loaded.id;
      setCurrentTime(0);
      dispatch({ type: 'questionLoaded', question: loaded });
      await playJingle('set');
      dispatch({ type: 'jingleEnded' });
    } catch (reason: unknown) {
      dispatch({
        type: 'loadFailed',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, [entries, auto, ai]);

  /**
   * 早押し。音声と文字送りの双方をその場で止める。
   *
   * 手動（ボタン・スペースキー）と自動（Jev）の双方から呼ぶ。
   * 自動の場合は判定した時点の文字数を渡し、そこで止める。
   *
   * 受理したかを返す。自動側は判定から押下までに時間があり、その間に
   * 読み切られた・人間が先に押した場合は押せない。押せなかったことを
   * 伝えないと、自動側が押下済みとみなして以降の判定を止めてしまう。
   */
  const handleBuzz = useCallback(
    (atChars?: number): boolean => {
      if (!canBuzz(phase) || question === null) return false;

      const audio = audioRef.current;
      const at = audio?.currentTime ?? currentTime;
      audio?.pause();
      stopTracking();
      // rAF を止めた時点で state の currentTime は最後のフレームのまま古くなる。
      // AI が誤答して frozenLength が null へ戻ると、表示はこの state を基準に
      // 戻るため、追従が再開するまで一瞬だけ文字が減って見える。
      setCurrentTime(at);

      // 押したことのフィードバックなので、鳴り終わりを待たずに回答へ進ませる
      void playJingle('buzz');

      // 以降この問題では判定しない。押した後に Jev の判定が続くと、
      // 届いた応答が押下を試みることになる。
      autoStopRef.current();

      // 表示は、実際に読み進んだところまでを残す。自動の場合、判定の間に
      // 再生が進んで判定時点より先まで読まれているが、そこで表示を判定位置
      // まで巻き戻すと、読まれた文字が消えて見える。
      const shown = Math.max(visibleLength(question.alignment, at), atChars ?? 0);
      const text = [...question.text].slice(0, shown).join('');

      // 人間が押した場合。従来どおり人間が回答する
      if (atChars === undefined) {
        dispatch({ type: 'buzz', visibleLength: shown });
        return true;
      }

      // Jev が押した場合。LLM へ回答させる。
      // 押す根拠になった位置（atChars）は judgedLength として別に持ち、
      // 表示ではなく「どこで判定したか」を示すためだけに使う。
      dispatch({ type: 'aiBuzz', visibleLength: shown, judgedLength: atChars });

      // 渡すのは実際に読み上げられた部分まで（shown）。Jev が判断した位置
      // （atChars）ではない。画面にはここまで出ており、人間が同じ位置で
      // 押した場合にも同じ範囲が見えている。AI にだけ狭い範囲を渡すと
      // 対決の条件が人間より不利になる。
      ai.run(text, (consensus) => {
        const correct =
          consensus.answer !== null && isCorrect(consensus.answer, question.answers);
        void playJingle(correct ? 'correct' : 'wrong');
        // 誤答なら reading へ戻る。止めた位置から読み上げを続けるため、
        // 再開であることを effect へ伝える
        resumeRef.current = !correct;
        dispatch({
          type: 'aiSettled',
          answer: consensus.answer,
          consensus,
          correct,
        });
      });
      return true;
    },
    [phase, question, currentTime, stopTracking, ai],
  );

  // 自動側から最新の handleBuzz を呼べるようにする。
  // 理由を出すのは受理されたときだけ。押せていないのに
  // 「Jev が押しました」と出すと、手動で押した場合や読み切った場合に
  // 誤った表示になる。
  useEffect(() => {
    buzzRef.current = (chars: number, reason: string) => {
      const accepted = handleBuzz(chars);
      if (accepted) setPressedReason(reason);
      return accepted;
    };
  }, [handleBuzz]);

  /** 早押しされないまま音声が終わった場合 */
  const handleAudioEnded = useCallback(() => {
    if (question === null) return;
    stopTracking();
    // 読み切った後に届いた応答で押させない
    autoStopRef.current();
    dispatch({
      type: 'audioEnded',
      visibleLength: [...question.text].length,
    });
  }, [question, stopTracking]);

  const handleSubmitAnswer = useCallback(
    (input: string) => {
      if (question === null) return;
      const correct = isCorrect(input, question.answers);
      dispatch({ type: 'judged', judgement: { input, correct, by: 'human' } });
      void playJingle(correct ? 'correct' : 'wrong');
    },
    [question],
  );

  // スペースキーでも早押しできるようにする
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' && event.key !== ' ') return;
      if (!canBuzz(phase)) return;

      // 入力欄にフォーカスがある場合は通常のスペース入力として扱う
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }

      event.preventDefault();
      handleBuzz();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [phase, handleBuzz]);

  const isPlaying = phase === 'jingle' || phase === 'reading';

  return (
    <main className="app">
      <h1 className="app-title">早押しクイズ（Jev 自動早押し）</h1>

      {(phase === 'loading' || phase === 'idle') && (
        <StartScreen
          label={phase === 'loading' ? '読み込み中…' : '開始'}
          disabled={phase === 'loading' || entries.length === 0}
          error={error}
          onStart={() => void startQuestion()}
        />
      )}

      {question !== null && phase !== 'idle' && phase !== 'loading' && (
        <>
          <audio
            ref={audioRef}
            src={question.audioUrl}
            onEnded={handleAudioEnded}
            preload="auto"
          />

          <QuestionView
            text={phase === 'jingle' ? '' : shownText}
            judgedLength={judgedLength}
          />

          {isPlaying && (
            <BuzzButton disabled={!canBuzz(phase)} onBuzz={() => handleBuzz()} />
          )}

          {(phase === 'aiAnswering' || aiAttempt !== null) && (
            <AiAnswerView
              slots={ai.state.slots}
              consensus={ai.state.consensus}
              correct={
                aiAttempt === null
                  ? null
                  : judgement?.by === 'ai' && judgement.correct
              }
              available={ai.health === 'online'}
              readText={ai.state.readText}
            />
          )}

          {phase === 'reading' && aiAttempt !== null && (
            <p className="notice">AI が外しました。解答権はあなたです</p>
          )}

          {pressedReason !== null && (
            <p className="jev-pressed-reason">
              Jev が押しました
              {judgedLength !== null && `（${judgedLength} 字時点の判定）`}:{' '}
              {pressedReason}
            </p>
          )}

          {canAnswer(phase) && (
            <>
              {phase === 'timeUp' && (
                <p className="notice">問題文を最後まで読み切りました</p>
              )}
              <AnswerInput onSubmit={handleSubmitAnswer} />
            </>
          )}

          {phase === 'result' && judgement !== null && (
            <ResultView
              correct={judgement.correct}
              input={judgement.input}
              answer={formatAnswer(question.answers)}
              fullText={question.text}
              onNext={() => void startQuestion()}
            />
          )}
        </>
      )}

      <JevPanel
        health={auto.health}
        info={auto.info}
        enabled={auto.enabled}
        logs={auto.logs}
        onToggle={auto.setEnabled}
        onRefresh={() => void auto.refresh()}
      />
    </main>
  );
}
