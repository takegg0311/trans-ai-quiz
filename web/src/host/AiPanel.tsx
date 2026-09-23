/**
 * AI の参加操作。出題者だけが見る欄。
 *
 * 参加させると Jev が読み上げ中に自動で早押しし、押したら 3 モデルの
 * 合議で回答する。正誤の判定は出題者が押す（人間と同じ扱い）。
 */
import { ASKING_MIN, BUZZ_WEAK } from '../lib/decision';
import type { AiJudgement, AiReadiness } from './useAiPlayer';

type Props = {
  enabled: boolean;
  readiness: AiReadiness;
  /** 直近の判定。なぜ押した／押さなかったかを出題者が確認するため */
  lastJudgement: AiJudgement | null;
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
        <div className="ai-panel-judgement">
          <p className="ai-panel-judgement-head">
            {lastJudgement.chars} 字
            <span className="ai-panel-judgement-reason">{lastJudgement.reason}</span>
          </p>

          {/* 閾値の位置に目盛りを出す。数字だけだと「あと少しで押す」のか
              「まだ遠い」のかが読み取りにくい */}
          <Gauge label="buzz" value={lastJudgement.buzz} threshold={BUZZ_WEAK} />
          <Gauge label="asking" value={lastJudgement.asking} threshold={ASKING_MIN} />
          {/* parallel は押下判定に使っていない（記録用）ので目盛りを出さない */}
          <Gauge label="parallel" value={lastJudgement.parallel} threshold={null} />
        </div>
      )}
    </section>
  );
}

type GaugeProps = {
  label: string;
  /** 0〜1 の観測値。欠測なら null */
  value: number | null;
  /**
   * 押下判定に使う閾値。ここを超えると条件を満たす。
   * 判定に使わない指標では null にして目盛りを出さない。
   */
  threshold: number | null;
};

/**
 * 観測値を 0〜1 のバーで出す。
 *
 * 数字だけだと「あと少しで押すのか、まだ遠いのか」が読み取りにくい。
 * 閾値の位置に目盛りを引き、超えているかを色で示す。
 */
function Gauge({ label, value, threshold }: GaugeProps) {
  const filled = value === null ? 0 : Math.min(Math.max(value, 0), 1);
  const reached = threshold !== null && value !== null && value >= threshold;

  return (
    <div className="ai-gauge">
      <span className="ai-gauge-label">{label}</span>
      <span className="ai-gauge-track">
        <span
          className={`ai-gauge-fill${reached ? ' is-reached' : ''}`}
          style={{ width: `${filled * 100}%` }}
        />
        {threshold !== null && (
          <span
            className="ai-gauge-threshold"
            style={{ left: `${threshold * 100}%` }}
            aria-hidden="true"
          />
        )}
      </span>
      <span className="ai-gauge-value">{value === null ? '—' : value.toFixed(2)}</span>
    </div>
  );
}
