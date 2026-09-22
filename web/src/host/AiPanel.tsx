/**
 * AI の参加操作。出題者だけが見る欄。
 *
 * 参加させると Jev が読み上げ中に自動で早押しし、押したら 3 モデルの
 * 合議で回答する。正誤の判定は出題者が押す（人間と同じ扱い）。
 */
import type { AiReadiness } from './useAiPlayer';

type Props = {
  enabled: boolean;
  readiness: AiReadiness;
  /** 直近の判定。なぜ押した／押さなかったかを出題者が確認するため */
  lastJudgement: string | null;
  /** 出題中は切り替えさせない。ラウンドの途中で条件が変わると追えなくなる */
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onRefresh: () => void;
};

export function AiPanel({
  enabled,
  readiness,
  lastJudgement,
  disabled,
  onToggle,
  onRefresh,
}: Props) {
  return (
    <section className="ai-panel">
      <header className="ai-panel-header">
        <h2>AI 参加者</h2>
        <label className="ai-panel-toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled || !readiness.jev}
            onChange={(event) => onToggle(event.target.checked)}
          />
          参加させる
        </label>
      </header>

      {!readiness.jev && (
        <p className="ai-panel-notice">
          Jev に接続できません（`TYPESAFE_API_KEY` を確認してください）。
          <button type="button" onClick={onRefresh}>
            再チェック
          </button>
        </p>
      )}

      {readiness.jev && !readiness.llm && (
        <p className="ai-panel-notice">
          LLM に接続できません。早押しはしますが回答できません
          （Claude / Gemini / Grok のキーを確認してください）。
          <button type="button" onClick={onRefresh}>
            再チェック
          </button>
        </p>
      )}

      {enabled && lastJudgement !== null && (
        <p className="ai-panel-judgement">{lastJudgement}</p>
      )}
    </section>
  );
}
