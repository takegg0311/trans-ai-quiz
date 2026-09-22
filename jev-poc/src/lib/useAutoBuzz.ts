/**
 * 自動早押しの状態管理。
 *
 * 出題サイクル（quizMachine）とは分けている。判定は読み上げ中に非同期で
 * 進み、押下は副作用として起きるため、同じ状態機械に混ぜると出題の遷移が
 * 読めなくなる。
 *
 * 送信は文字数の変化で駆動する。1 文字ごとに時間で回すと、無音区間や長音で
 * 同じ文字列を繰り返し投げることになるため。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { decide, type Judgement } from './decision';
import { checkHealth, judge, type JevHealth, type JudgeResult } from './jev';

/** server との疎通状態 */
export type HealthStatus = 'checking' | 'online' | 'offline';

/** 1 回の判定の記録。画面の時系列表示に使う */
export type JudgeLog = {
  /** 判定時点の文字数 */
  chars: number;
  result: JudgeResult;
  judgement: Judgement | null;
};

/**
 * 判定の履歴として保持する上限。
 * 長い問題文でも全件残るが、際限なく伸ばさないために上限を置く。
 */
const MAX_LOGS = 200;

export function useAutoBuzz(onPress: (chars: number, reason: string) => void) {
  const [health, setHealth] = useState<HealthStatus>('checking');
  const [info, setInfo] = useState<JevHealth | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [logs, setLogs] = useState<JudgeLog[]>([]);

  /** 送信中かどうか。応答待ちの間に何本も投げないため */
  const inFlightRef = useRef(false);
  /** 直近で送信した文字数。変化したときだけ送る */
  const lastSentRef = useRef(-1);
  /**
   * 判定の世代。次の問題へ進んだ後に前問の応答が届いても捨てるため。
   * 押下は取り消せないので、世代違いの応答で押さないことが重要になる。
   */
  const generationRef = useRef(0);
  /** 既に押したか。1 問につき 1 回だけ押す */
  const pressedRef = useRef(false);

  /** onPress の同一性に依存せず最新を呼ぶ */
  const onPressRef = useRef(onPress);
  useEffect(() => {
    onPressRef.current = onPress;
  }, [onPress]);

  const refresh = useCallback(async () => {
    setHealth('checking');
    const found = await checkHealth();

    if (found === null || !found.available) {
      setHealth('offline');
      setInfo(found);
      return;
    }

    setHealth('online');
    setInfo(found);
  }, []);

  // 起動時に 1 回だけ確認する。以降は再チェックボタンから呼ぶ
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 判定の状態を捨てる。次の問題へ進むときに呼ぶ */
  const reset = useCallback(() => {
    generationRef.current += 1;
    inFlightRef.current = false;
    lastSentRef.current = -1;
    pressedRef.current = false;
    setLogs([]);
  }, []);

  /**
   * 読み上げ済みの問題文を評価する。表示文字数が変わるたびに呼ぶ。
   *
   * 応答待ちの間に文字が進んでも、投げるのは応答が返ってからの 1 回だけ。
   * 検出中に問題文が進むことは許容する（人間の早押しでも生じる時間差）。
   */
  const feed = useCallback(
    (partialText: string, chars: number) => {
      if (!enabled || health !== 'online') return;
      if (pressedRef.current) return;
      if (inFlightRef.current) return;
      if (chars === lastSentRef.current || chars === 0) return;

      lastSentRef.current = chars;
      inFlightRef.current = true;

      const generation = generationRef.current;

      void judge(partialText).then((result) => {
        inFlightRef.current = false;

        // 次の問題へ進んだ後に届いた応答で押さない
        if (generationRef.current !== generation) return;

        const judgement =
          result.status === 'ok'
            ? decide(partialText, result.buzz, result.asking)
            : null;

        setLogs((current) => {
          const next = [...current, { chars, result, judgement }];
          return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
        });

        if (judgement?.press === true && !pressedRef.current) {
          pressedRef.current = true;
          // 理由を引数で渡す。setLogs と同じ処理内で呼ぶため、呼び出し側から
          // logs を読むと 1 つ前の判定が見えてしまう。
          onPressRef.current(chars, judgement.reason);
        }
      });
    },
    [enabled, health],
  );

  return { health, info, enabled, setEnabled, logs, feed, reset, refresh };
}
