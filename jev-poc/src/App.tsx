import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ProviderSlot } from './components/ProviderSlot';
import { RevealModal } from './components/RevealModal';
import { visibleLength } from './lib/align';
import {
  SILENT_CHAR_INTERVAL_MS,
  loadManifest,
  loadQuestion,
  pickRandom,
  type ManifestEntry,
} from './lib/manifest';
import {
  PROVIDER_IDS,
  type EnabledMap,
  type ProviderId,
} from './lib/providerPrefs';
import { shouldEndSilentReading } from './lib/silentReading';
import { playJingle } from './lib/sound';
import { useProviderHealth } from './lib/useProviderHealth';
import { useSlotJudge } from './lib/useSlotJudge';
import {
  canReveal,
  canStart,
  initialState,
  quizReducer,
} from './state/quizMachine';

export function App() {
  const [state, dispatch] = useReducer(quizReducer, initialState);
  const [entries, setEntries] = useState<ManifestEntry[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  /** 音声なし問題の表示文字数 */
  const [silentChars, setSilentChars] = useState(0);
  const [frozenEnabled, setFrozenEnabled] = useState<EnabledMap | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const silentTimerRef = useRef<number | null>(null);
  const lastIdRef = useRef<string | undefined>(undefined);
  const readingLengthRef = useRef(0);
  /** phase の再描画前に連打されても二重開始しないためのガード */
  const startInFlightRef = useRef(false);

  const health = useProviderHealth();
  const { phase, question, error } = state;

  const slotEnabled = frozenEnabled ?? health.enabled;
  const toggleable = phase === 'idle' && health.status === 'ready';

  useEffect(() => {
    let cancelled = false;
    loadManifest()
      .then((loaded) => {
        if (cancelled) return;
        if (loaded.length === 0) {
          dispatch({
            type: 'loadFailed',
            message:
              '問題が 1 問もありません。quiz_data に questions.csv を配置してください。',
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

  const totalLength = question === null ? 0 : [...question.text].length;
  const fullText = question?.text ?? '';

  const readingLength =
    question === null
      ? 0
      : question.hasAudio && question.alignment !== null
        ? visibleLength(question.alignment, currentTime)
        : silentChars;
  readingLengthRef.current = readingLength;
  const currentLength = useCallback(() => readingLengthRef.current, []);

  const typesafe = useSlotJudge({
    provider: 'typesafe',
    active:
      slotEnabled.typesafe &&
      (phase === 'reading' || phase === 'readEnded' || phase === 'reveal'),
    totalLength,
    currentLength,
  });
  const openai = useSlotJudge({
    provider: 'openai',
    active:
      slotEnabled.openai &&
      (phase === 'reading' || phase === 'readEnded' || phase === 'reveal'),
    totalLength,
    currentLength,
  });
  const gemini = useSlotJudge({
    provider: 'gemini',
    active:
      slotEnabled.gemini &&
      (phase === 'reading' || phase === 'readEnded' || phase === 'reveal'),
    totalLength,
    currentLength,
  });

  const slots = { typesafe, openai, gemini };

  const stopTracking = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (silentTimerRef.current !== null) {
      window.clearInterval(silentTimerRef.current);
      silentTimerRef.current = null;
    }
  }, []);

  const finishReading = useCallback(() => {
    stopTracking();
    for (const id of PROVIDER_IDS) {
      if (slotEnabled[id]) slots[id].markReadEnded();
    }
    dispatch({ type: 'audioEnded' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    stopTracking,
    slotEnabled.typesafe,
    slotEnabled.openai,
    slotEnabled.gemini,
    typesafe.markReadEnded,
    openai.markReadEnded,
    gemini.markReadEnded,
  ]);

  // 音声あり: reading の間だけ再生位置を追う
  useEffect(() => {
    if (phase !== 'reading' || question === null || !question.hasAudio) return;
    const audio = audioRef.current;
    if (audio === null) return;

    audio.currentTime = 0;
    setCurrentTime(0);

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
  }, [phase, question, stopTracking]);

  // 音声なし: 等速の文字送り（120ms）。ON の全枠が押したら読み切り。
  useEffect(() => {
    if (phase !== 'reading' || question === null || question.hasAudio) return;

    setSilentChars(0);
    silentTimerRef.current = window.setInterval(() => {
      setSilentChars((current) => {
        const next = Math.min(current + 1, totalLength);
        return next;
      });
    }, SILENT_CHAR_INTERVAL_MS);

    return stopTracking;
  }, [phase, question, totalLength, stopTracking]);

  // 音声なしの読み切り条件（全文送り終え / ON の全枠が押した）
  useEffect(() => {
    if (phase !== 'reading' || question === null) return;

    const activeIds = PROVIDER_IDS.filter((id) => slotEnabled[id]);
    const end = shouldEndSilentReading({
      hasAudio: question.hasAudio,
      shownLength: readingLength,
      totalLength,
      activePressed: activeIds.map(
        (id) => slots[id].state.display?.pressed === true,
      ),
    });
    if (end) finishReading();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    phase,
    question,
    readingLength,
    totalLength,
    slotEnabled.typesafe,
    slotEnabled.openai,
    slotEnabled.gemini,
    typesafe.state.display?.pressed,
    openai.state.display?.pressed,
    gemini.state.display?.pressed,
    finishReading,
  ]);

  // 読み上げ中だけ判定を送る
  useEffect(() => {
    if (phase !== 'reading' || question === null) return;
    if (readingLength === 0) return;

    const partial = [...question.text].slice(0, readingLength).join('');
    for (const id of PROVIDER_IDS) {
      if (!slotEnabled[id]) continue;
      slots[id].setLiveLength(readingLength);
      slots[id].feed(partial, readingLength);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    phase,
    question,
    readingLength,
    slotEnabled.typesafe,
    slotEnabled.openai,
    slotEnabled.gemini,
    typesafe.feed,
    openai.feed,
    gemini.feed,
    typesafe.setLiveLength,
    openai.setLiveLength,
    gemini.setLiveLength,
  ]);

  const resetAllSlots = useCallback(() => {
    typesafe.reset();
    openai.reset();
    gemini.reset();
  }, [typesafe.reset, openai.reset, gemini.reset]);

  const startQuestion = useCallback(async () => {
    if (!canStart(phase) || !health.canStart) return;
    if (startInFlightRef.current) return;
    const entry = pickRandom(entries, lastIdRef.current);
    if (entry === undefined) return;

    startInFlightRef.current = true;
    dispatch({ type: 'start' });
    setFrozenEnabled({ ...health.enabled });
    resetAllSlots();
    setCurrentTime(0);
    setSilentChars(0);

    try {
      const loaded = await loadQuestion(entry);
      lastIdRef.current = loaded.id;
      dispatch({ type: 'questionLoaded', question: loaded });
      await playJingle('set');
      dispatch({ type: 'jingleEnded' });
    } catch (reason: unknown) {
      startInFlightRef.current = false;
      setFrozenEnabled(null);
      dispatch({
        type: 'loadFailed',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, [phase, health.canStart, health.enabled, entries, resetAllSlots]);

  const handleAudioEnded = useCallback(() => {
    if (phase !== 'reading' || question === null || !question.hasAudio) return;
    finishReading();
  }, [phase, question, finishReading]);

  const handleNext = useCallback(() => {
    startInFlightRef.current = false;
    resetAllSlots();
    setFrozenEnabled(null);
    dispatch({ type: 'next' });
  }, [resetAllSlots]);

  const startDisabled =
    !canStart(phase) || !health.canStart || entries.length === 0;

  return (
    <div className="app">
      <header className="app-header">
        <h1>判定比較 PoC</h1>
        <p className="app-lead">3 社の早押し判定を同じ問題で並べて比べる</p>
      </header>

      {error !== null && <p className="error-banner">{error}</p>}

      {health.status === 'offline' && (
        <p className="error-banner">
          判定サーバに接続できません。
          <button type="button" onClick={() => void health.refresh()}>
            再チェック
          </button>
        </p>
      )}

      {health.status === 'checking' && (
        <p className="status-banner">判定サーバを確認しています…</p>
      )}

      <div className="slots">
        {PROVIDER_IDS.map((id: ProviderId) => (
          <ProviderSlot
            key={id}
            provider={id}
            info={health.providerInfo(id)}
            enabled={slotEnabled[id]}
            toggleable={toggleable && (health.available?.[id] ?? false)}
            available={health.available?.[id] ?? false}
            fullText={phase === 'idle' ? '' : fullText}
            readingLength={readingLength}
            slot={slots[id].state}
            onToggle={(value) => health.setProviderEnabled(id, value)}
          />
        ))}
      </div>

      <div className="app-actions">
        {phase === 'idle' || phase === 'loading' ? (
          <button
            type="button"
            className="primary-button"
            disabled={startDisabled}
            onClick={() => void startQuestion()}
          >
            出題する
          </button>
        ) : (
          <button
            type="button"
            className="primary-button"
            disabled={!canReveal(phase)}
            onClick={() => dispatch({ type: 'openReveal' })}
          >
            全文・正解確認
          </button>
        )}
      </div>

      {question !== null && question.hasAudio && question.audioUrl !== null && (
        <audio
          ref={audioRef}
          src={question.audioUrl}
          preload="auto"
          onEnded={handleAudioEnded}
        />
      )}

      {phase === 'reveal' && question !== null && (
        <RevealModal
          text={question.text}
          answers={question.answers}
          onClose={() => dispatch({ type: 'closeReveal' })}
          onNext={handleNext}
        />
      )}
    </div>
  );
}
