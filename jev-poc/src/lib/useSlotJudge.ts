/**
 * 1 枠ぶんの自動早押し判定。
 *
 * 送信中は次を投げない／文字数が変わったときだけ送る／世代で古い応答を捨てる／
 * 押したらその枠は判定を止める。useAutoBuzz と同じ制御を枠ごとに持つ。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { decide } from './decision';
import { judge, type JudgeResult } from './judge';
import type { ProviderId } from './providerPrefs';
import { resolvePress, type SlotDisplay } from './slotPress';

export type SlotJudgement = {
  buzz: number | null;
  parallel: number | null;
  asking: number | null;
  reason: string;
  press: boolean;
};

export type SlotState = {
  /** 読み上げ中に伸ばす白の文字数。押した後は whiteLength を優先 */
  liveLength: number;
  display: SlotDisplay | null;
  judgement: SlotJudgement | null;
  error: string | null;
};

const EMPTY: SlotState = {
  liveLength: 0,
  display: null,
  judgement: null,
  error: null,
};

type Options = {
  provider: ProviderId;
  /** この枠が判定するか。出題開始時に固定した値を渡す */
  active: boolean;
  /** 問題文の全文長。押下条件の判定に使う */
  totalLength: number;
  /**
   * 応答が届いた時点の「今の表示文字数」を返す。
   * 読み上げが止まっていても、届いた瞬間の位置が灰の終点になる。
   */
  currentLength: () => number;
};

export function useSlotJudge({
  provider,
  active,
  totalLength,
  currentLength,
}: Options) {
  const [state, setState] = useState<SlotState>(EMPTY);

  const inFlightRef = useRef(false);
  const lastSentRef = useRef(-1);
  const generationRef = useRef(0);
  const pressedRef = useRef(false);
  const activeRef = useRef(active);
  const totalRef = useRef(totalLength);
  const currentLengthRef = useRef(currentLength);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    totalRef.current = totalLength;
  }, [totalLength]);
  useEffect(() => {
    currentLengthRef.current = currentLength;
  }, [currentLength]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    inFlightRef.current = false;
    lastSentRef.current = -1;
    pressedRef.current = false;
    setState(EMPTY);
  }, []);

  /** 読み上げ中の表示長を白で伸ばす。押した後は触らない */
  const setLiveLength = useCallback((chars: number) => {
    if (pressedRef.current) return;
    setState((current) =>
      current.liveLength === chars ? current : { ...current, liveLength: chars },
    );
  }, []);

  /** 押さずに読み切ったときの全文灰。応答待ちが後から押下なら上書きされる */
  const markReadEnded = useCallback(() => {
    if (pressedRef.current) return;
    setState((current) => ({
      ...current,
      liveLength: totalRef.current,
      display: {
        pressed: false,
        whiteLength: null,
        grayLength: totalRef.current,
      },
    }));
  }, []);

  const feed = useCallback(
    (partialText: string, chars: number) => {
      if (!activeRef.current) return;
      if (pressedRef.current) return;
      if (inFlightRef.current) return;
      if (chars === lastSentRef.current || chars === 0) return;

      lastSentRef.current = chars;
      inFlightRef.current = true;
      const generation = generationRef.current;
      const judgedLength = chars;

      void judge(partialText, provider).then((result: JudgeResult) => {
        if (generationRef.current !== generation) return;
        inFlightRef.current = false;

        if (result.status !== 'ok') {
          setState((current) => ({
            ...current,
            error: result.message,
          }));
          return;
        }

        const decision = decide(partialText, result.buzz, result.asking);
        const judgement: SlotJudgement = {
          buzz: result.buzz,
          parallel: result.parallel,
          asking: result.asking,
          reason: decision.reason,
          press: decision.press,
        };

        if (!decision.press || pressedRef.current) {
          setState((current) => ({
            ...current,
            judgement,
            error: null,
          }));
          return;
        }

        const arrived = currentLengthRef.current();
        const display = resolvePress(judgedLength, arrived, totalRef.current);
        if (!display.pressed) {
          setState((current) => ({
            ...current,
            judgement: { ...judgement, press: false },
            error: null,
          }));
          return;
        }

        pressedRef.current = true;
        setState({
          liveLength: display.grayLength ?? arrived,
          display,
          judgement,
          error: null,
        });
      });
    },
    [provider],
  );

  return { state, feed, reset, setLiveLength, markReadEnded };
}
