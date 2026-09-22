/**
 * AI 参加者の制御。出題者フロントに置く。
 *
 * サーバは文字位置を持たない（room.py は「早押しを受け付けてよいか」
 * 「正解を出してよいか」を決めるためだけに存在する）。Jev の判定には
 * 「今何文字目か」が要るため、既にそれを持っている出題者フロントで行う。
 *
 * 流れ:
 *   読み上げ中 → Jev が確定ポイントと判断 → ai_buzz をサーバへ
 *   → 3 モデルへ並列送信 → 合議 → ai_answer をサーバへ
 *
 * 判定（正誤）はここでは行わない。出題者が check で正解を確認してから
 * judge を押す。合議が固まった瞬間に判定すると、投影を見ている全員へ
 * 「正解はこれです。AI の回答はこれでした」と見せる間が無くなる。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canSettleEarly,
  decideConsensus,
  describeConsensus,
  type ModelAnswer,
} from '../lib/consensus';
import { decide } from '../lib/decision';
import { checkHealth as checkJevHealth, judge as judgeJev } from '../lib/jev';
import { checkHealth as checkLlmHealth, predict, type PredictResult } from '../lib/llm';
import type { AiModelAnswerView, ClientMessage } from '../protocol';

/**
 * 対決の相手。画面からは選べない。
 * 毎回同じ相手にすることで勝敗の比較が成立する。
 */
export const OPPONENTS: { vendor: string; model: string; label: string }[] = [
  { vendor: 'anthropic', model: 'claude-sonnet-5', label: 'Claude' },
  { vendor: 'google', model: 'gemini-3.7-flash', label: 'Gemini' },
  { vendor: 'xai', model: 'grok-4.3', label: 'Grok' },
];

export type AiReadiness = {
  /** Jev が使えるか。これが false なら自動早押ししない */
  jev: boolean;
  /** 3 モデルすべてが使えるか。false でも早押しはする（回答できないだけ） */
  llm: boolean;
};

type Props = {
  /** サーバへメッセージを送る */
  send: (message: ClientMessage) => void;
  /** 現在の round_id。世代管理に使う */
  roundId: number;
};

export function useAiPlayer({ send, roundId }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [readiness, setReadiness] = useState<AiReadiness>({ jev: false, llm: false });
  /** 判定の履歴。押した理由を出題者が確認するために持つ */
  const [lastJudgement, setLastJudgement] = useState<string | null>(null);

  const sendRef = useRef(send);
  sendRef.current = send;
  const roundRef = useRef(roundId);
  roundRef.current = roundId;
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  /** 送信中かどうか。応答待ちの間に何本も投げない */
  const inFlightRef = useRef(false);
  /** 直近で送信した文字数。変化したときだけ送る */
  const lastSentRef = useRef(-1);
  /** このラウンドで既に押したか */
  const pressedRef = useRef(false);
  /** 疎通確認の世代。古い結果で新しい結果を上書きしない */
  const healthGenerationRef = useRef(0);

  const refresh = useCallback(async () => {
    healthGenerationRef.current += 1;
    const generation = healthGenerationRef.current;

    const [jevHealth, providers] = await Promise.all([
      checkJevHealth(),
      checkLlmHealth(),
    ]);

    if (healthGenerationRef.current !== generation) return;

    const llmReady =
      providers !== null &&
      OPPONENTS.every((opponent) =>
        providers.some(
          (provider) =>
            provider.vendor === opponent.vendor &&
            provider.available &&
            provider.models.includes(opponent.model),
        ),
      );

    setReadiness({
      jev: jevHealth !== null && jevHealth.available,
      llm: llmReady,
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** ラウンドが変わったら状態を捨てる */
  const reset = useCallback(() => {
    inFlightRef.current = false;
    lastSentRef.current = -1;
    pressedRef.current = false;
    setLastJudgement(null);
  }, []);

  /** 人間が先に押した場合など、これ以上判定しない */
  const stop = useCallback(() => {
    pressedRef.current = true;
  }, []);

  /**
   * 3 モデルへ並列送信し、合議が固まったらサーバへ送る。
   *
   * 多数決が覆らなくなった時点で打ち切る。早押しでは回答までの速さも
   * 勝敗に関わるため、結果が決まっている応答を待たない。
   * 遅れて届いた応答は送信済みの結果を変えない。
   */
  const runAnswer = useCallback((partialText: string, round: number) => {
    const answers: (ModelAnswer | null)[] = OPPONENTS.map(() => null);
    let settled = false;

    OPPONENTS.forEach((opponent, index) => {
      void predict(opponent.vendor, opponent.model, partialText, false).then(
        (result: PredictResult) => {
          // 次の問題へ進んだ後に届いた応答は捨てる
          if (roundRef.current !== round) return;

          answers[index] = {
            vendor: opponent.vendor,
            model: opponent.model,
            result,
          };
          if (settled) return;

          const arrived = answers.filter(
            (answer): answer is ModelAnswer => answer !== null,
          );
          if (!canSettleEarly(arrived, OPPONENTS.length)) return;

          settled = true;
          const consensus = decideConsensus(arrived);
          sendRef.current({
            type: 'ai_answer',
            round_id: round,
            answer: consensus.answer,
            reason: describeConsensus(consensus),
            models: toModelViews(answers),
          });
        },
      );
    });
  }, []);

  /**
   * 読み上げ済みの問題文を評価する。表示文字数が変わるたびに呼ぶ。
   *
   * 送信は文字数の変化で駆動する。時間で回すと、無音区間や長音で同じ
   * 文字列を繰り返し投げることになる。
   */
  const feed = useCallback(
    (partialText: string, chars: number) => {
      if (!enabledRef.current || !readiness.jev) return;
      if (pressedRef.current || inFlightRef.current) return;
      if (chars === lastSentRef.current || chars === 0) return;

      lastSentRef.current = chars;
      inFlightRef.current = true;
      const round = roundRef.current;

      void judgeJev(partialText).then((result) => {
        // 次の問題へ進んだ後に届いた応答では押さない
        if (roundRef.current !== round) return;
        inFlightRef.current = false;

        if (result.status !== 'ok') return;

        const judgement = decide(partialText, result.buzz, result.asking);
        setLastJudgement(`${chars} 字: ${judgement.reason}`);

        if (!judgement.press || pressedRef.current) return;
        // 送信後に AI を外されていれば押さない
        if (!enabledRef.current) return;

        pressedRef.current = true;
        sendRef.current({ type: 'ai_buzz', round_id: round, judged_length: chars });
        // 押した時点で読み上げられていた範囲を渡す。Jev が判断した位置では
        // ない——人間が同じ位置で押した場合にも同じ範囲が聞こえている
        runAnswer(partialText, round);
      });
    },
    [readiness.jev, runAnswer],
  );

  return { enabled, setEnabled, readiness, lastJudgement, feed, reset, stop, refresh };
}

/** 各モデルの応答を投影用の形へ写す */
function toModelViews(answers: (ModelAnswer | null)[]): AiModelAnswerView[] {
  return answers.flatMap((answer, index) => {
    const opponent = OPPONENTS[index];
    if (opponent === undefined) return [];
    if (answer === null) {
      return [{ label: opponent.label, answer: '', elapsed_ms: 0, error: '応答なし' }];
    }

    const { result } = answer;
    switch (result.status) {
      case 'ok':
        return [
          { label: opponent.label, answer: result.answer, elapsed_ms: result.elapsedMs },
        ];
      case 'violation':
        return [
          {
            label: opponent.label,
            answer: '',
            elapsed_ms: result.elapsedMs,
            error: `違反: ${result.violation}`,
          },
        ];
      case 'error':
        return [
          {
            label: opponent.label,
            answer: '',
            elapsed_ms: result.elapsedMs,
            error: result.message,
          },
        ];
    }
  });
}
