/**
 * AI の回答の状態管理。
 *
 * Jev が早押しボタンを押したとき、その時点で読み上げられていた問題文を
 * 3 モデルへ並列に投げ、合議で答えを 1 つ決める。
 *
 * 出題サイクル（quizMachine）とは分けている。応答は最大 60 秒かかり、
 * 人間の回答とは独立に到着するため、同じ状態機械に混ぜると遷移が読めなくなる。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { decideConsensus, type Consensus, type ModelAnswer } from './consensus';
import { checkHealth, predict, type PredictResult } from './llm';

/** server との疎通状態 */
export type HealthStatus = 'checking' | 'online' | 'offline';

/**
 * 対決の相手。画面からは選べない。
 *
 * 毎回同じ相手にすることで勝敗の比較が成立する。llm-poc の枠選択は
 * モデル間の比較実験のための機能であり、こちらとは目的が違う。
 *
 * 各社の最上位ではなく軽量寄りのモデルを選んでいる。早押しでは応答の速さが
 * 勝敗に効くうえ、1 問ごとに 3 回叩くため費用も抑えたい。
 */
export const OPPONENTS: { vendor: string; model: string; label: string }[] = [
  { vendor: 'anthropic', model: 'claude-sonnet-5', label: 'Claude' },
  { vendor: 'google', model: 'gemini-3.7-flash', label: 'Gemini' },
  { vendor: 'xai', model: 'grok-4.3', label: 'Grok' },
];

/** 1 モデル分の状態 */
export type SlotState =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'done'; result: PredictResult };

export type AiAnswerState = {
  slots: SlotState[];
  /** 全モデルの応答がそろった時点の合議結果。途中は null */
  consensus: Consensus | null;
};

const IDLE: AiAnswerState = {
  slots: OPPONENTS.map(() => ({ state: 'idle' as const })),
  consensus: null,
};

export function useAiAnswer() {
  const [health, setHealth] = useState<HealthStatus>('checking');
  const [state, setState] = useState<AiAnswerState>(IDLE);

  /**
   * 送信の世代。次の問題へ進んだ後に前問の応答が届いても捨てるため。
   * 応答は最大 60 秒かかるので、遅れて到着しうる。
   */
  const generationRef = useRef(0);

  /** 疎通確認の世代。古い結果で新しい結果を上書きしないため */
  const healthGenerationRef = useRef(0);

  const refresh = useCallback(async () => {
    healthGenerationRef.current += 1;
    const generation = healthGenerationRef.current;

    setHealth('checking');
    const found = await checkHealth();

    if (healthGenerationRef.current !== generation) return;

    // 対決に使う 3 モデルがすべて使えるかを見る。1 つでも欠けると
    // 合議の前提（3 者の多数決）が崩れるため、その旨を画面へ出したい。
    const usable =
      found !== null &&
      OPPONENTS.every((opponent) =>
        found.some(
          (provider) =>
            provider.vendor === opponent.vendor &&
            provider.available &&
            provider.models.includes(opponent.model),
        ),
      );

    setHealth(usable ? 'online' : 'offline');
  }, []);

  // 起動時に 1 回だけ確認する。以降は再チェックボタンから呼ぶ
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 状態を捨てる。次の問題へ進むときに呼ぶ */
  const reset = useCallback(() => {
    generationRef.current += 1;
    setState(IDLE);
  }, []);

  /**
   * 3 モデルへ並列に送信し、そろった時点で合議する。
   *
   * partialText は、Jev が押した時点で**実際に読み上げられていた**問題文。
   * Jev が判断した位置ではない。判定から押下までの間も読み上げは進んでおり、
   * 画面にはその分まで表示されている。人間が同じ位置で押した場合にも同じ
   * 範囲が見えているため、AI にだけ狭い範囲を渡すと条件が不利になる。
   *
   * 完了時に onSettled で合議結果を返す。呼び出し側はこれを受けて
   * 正誤判定と遷移を行う。
   */
  const run = useCallback(
    (partialText: string, onSettled: (consensus: Consensus) => void) => {
      generationRef.current += 1;
      const generation = generationRef.current;

      setState({
        slots: OPPONENTS.map(() => ({ state: 'pending' as const })),
        consensus: null,
      });

      const answers: (ModelAnswer | null)[] = OPPONENTS.map(() => null);
      let remaining = OPPONENTS.length;

      OPPONENTS.forEach((opponent, index) => {
        void predict(opponent.vendor, opponent.model, partialText, false).then((result) => {
          // 次の問題へ進んだ後に届いた応答は捨てる
          if (generationRef.current !== generation) return;

          answers[index] = { vendor: opponent.vendor, model: opponent.model, result };
          remaining -= 1;

          setState((current) => ({
            ...current,
            slots: current.slots.map((slot, i) =>
              i === index ? { state: 'done', result } : slot,
            ),
          }));

          // 全モデルがそろってから合議する。先に多数決が確定していても
          // 待つのは、画面に 3 モデルの応答を並べて見せるため。
          // 勝敗より「どのモデルが何を答えたか」を残すことを優先する。
          if (remaining > 0) return;

          const consensus = decideConsensus(
            answers.filter((answer): answer is ModelAnswer => answer !== null),
          );
          setState((current) => ({ ...current, consensus }));
          onSettled(consensus);
        });
      });
    },
    [],
  );

  return { health, state, run, reset, refresh };
}
