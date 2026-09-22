/**
 * 自動早押しの状態管理。
 *
 * 出題サイクル（quizMachine）とは分けている。判定は読み上げ中に非同期で
 * 進み、押下は副作用として起きるため、同じ状態機械に混ぜると出題の遷移が
 * 読めなくなる。
 *
 * 送信は文字数の変化で駆動する。1 文字ごとに時間で回すと、無音区間や長音で
 * 同じ文字列を繰り返し投げることになるため。
 *
 * 判定は最短でも数百ミリ秒かかるため、応答が届く頃には状況が変わっている
 * ことがある。次の問題へ進んだ、人間が先に押した、自動を切った、読み切った。
 * **応答を受け取った時点の状況で判断し直す**必要があり、送信時の条件を
 * クロージャに閉じ込めたまま使わない。
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

/**
 * 押下を依頼する。実際に押せたかを返してもらう。
 *
 * 読み上げが終わっていた、人間が先に押していた、といった理由で
 * 押せないことがある。false が返った場合は押下済みとして扱わず、
 * 次の文字で判定を続ける。
 */
export type PressRequest = (chars: number, reason: string) => boolean;

export function useAutoBuzz(onPress: PressRequest) {
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

  /**
   * 応答を受け取った時点の enabled を読むための ref。
   *
   * feed のクロージャが捉えた enabled は送信時の値で、自動を切った後に
   * 届いた応答ではもう正しくない。
   */
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  /**
   * 疎通確認の世代。判定と同じく、古い応答で状態を上書きしないため。
   *
   * 「再チェック」を続けて押すと確認が複数本走る。後から返った方が
   * 状態を決めるので、先に投げたものがタイムアウトして offline を書くと、
   * 疎通しているのに自動早押しが止まってしまう。
   */
  const healthGenerationRef = useRef(0);

  const refresh = useCallback(async () => {
    healthGenerationRef.current += 1;
    const generation = healthGenerationRef.current;

    setHealth('checking');
    const found = await checkHealth();

    // 後から新しい確認が始まっていれば、こちらの結果は捨てる
    if (healthGenerationRef.current !== generation) return;

    setInfo(found);
    setHealth(found !== null && found.available ? 'online' : 'offline');
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
   * これ以上この問題で判定しない。人間が先に押した場合に呼ぶ。
   *
   * reset と違い世代は進めない。進めると、まだ届いていない応答が
   * 「次の問題のもの」と誤認されるわけではないが、世代を進める意味が
   * あるのは問題が変わったときだけであり、ここで混ぜると意図が濁る。
   */
  const stop = useCallback(() => {
    pressedRef.current = true;
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
        // 世代が一致するときだけフラグを戻す。前問の遅れた応答で
        // 現在の問題の送信中フラグを落とすと、1 問のあいだに判定が
        // 何本も走り、古い断片の判定が後から届いて押しうる。
        if (generationRef.current !== generation) return;
        inFlightRef.current = false;

        const judgement =
          result.status === 'ok'
            ? decide(partialText, result.buzz, result.asking)
            : null;

        setLogs((current) => {
          const next = [...current, { chars, result, judgement }];
          return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
        });

        if (judgement?.press !== true) return;
        if (pressedRef.current) return;
        // 送信後に自動を切られていれば押さない。判定の記録だけは残す
        if (!enabledRef.current) return;

        // 押下済みにするのは、呼び出し側が実際に受理してから。
        // 読み上げが終わっていた・人間が先に押していた場合は押せず、
        // ここで押下済みにすると以降の判定まで止まってしまう。
        // 理由を引数で渡すのは、setLogs と同じ処理内で呼ぶため、
        // 呼び出し側から logs を読むと 1 つ前の判定が見えるため。
        if (onPressRef.current(chars, judgement.reason)) {
          pressedRef.current = true;
        }
      });
    },
    [enabled, health],
  );

  return { health, info, enabled, setEnabled, logs, feed, reset, stop, refresh };
}
