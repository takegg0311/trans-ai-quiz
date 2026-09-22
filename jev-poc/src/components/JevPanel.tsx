/**
 * Jev 判定の表示。
 *
 * 押した理由をその場で見せることを主眼にしている。自動で押された際に
 * なぜ押したのかが分からないと、閾値を調整する手がかりが残らない。
 */
import {
  ASKING_MIN,
  BUZZ_STRONG,
  BUZZ_WEAK,
  PARALLEL_RISK_CHARS,
} from '../lib/decision';
import type { HealthStatus, JudgeLog } from '../lib/useAutoBuzz';
import type { JevHealth } from '../lib/jev';

type Props = {
  health: HealthStatus;
  info: JevHealth | null;
  enabled: boolean;
  logs: JudgeLog[];
  onToggle: (enabled: boolean) => void;
  onRefresh: () => void;
};

export function JevPanel({ health, info, enabled, logs, onToggle, onRefresh }: Props) {
  return (
    <section className="jev-panel">
      <header className="jev-panel-header">
        <h2>Jev 自動早押し</h2>
        <label className="jev-toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={health !== 'online'}
            onChange={(event) => onToggle(event.target.checked)}
          />
          自動で押す
        </label>
        {health !== 'online' && (
          <button type="button" onClick={onRefresh}>
            再チェック
          </button>
        )}
      </header>

      {health === 'checking' && <p className="notice">疎通確認中…</p>}

      {health === 'offline' && (
        <p className="notice">
          {info?.reason ?? 'サーバー未起動'} のため自動早押しは使えません。
          手動での早押しは従来どおり動きます。
        </p>
      )}

      {health === 'online' && (
        <p className="jev-rule">
          buzz ≧ {BUZZ_STRONG} で即押し／buzz ≧ {BUZZ_WEAK} は
          {PARALLEL_RISK_CHARS} 字以下なら asking ≧ {ASKING_MIN} を確認
        </p>
      )}

      {logs.length > 0 && (
        <table className="jev-log">
          <thead>
            <tr>
              <th>文字</th>
              <th>buzz</th>
              <th>asking</th>
              <th>parallel</th>
              <th>ms</th>
              <th>判定</th>
            </tr>
          </thead>
          <tbody>
            {[...logs].reverse().map((log, index) => (
              <tr
                key={`${log.chars}-${index}`}
                className={log.judgement?.press === true ? 'jev-pressed' : undefined}
              >
                <td>{log.chars}</td>
                {log.result.status === 'ok' ? (
                  <>
                    <td>{fmt(log.result.buzz)}</td>
                    <td>{fmt(log.result.asking)}</td>
                    <td>{fmt(log.result.parallel)}</td>
                    <td>{log.result.elapsedMs}</td>
                    <td>{log.judgement?.reason ?? ''}</td>
                  </>
                ) : (
                  <td colSpan={5} className="jev-error">
                    {log.result.message}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** 欠測は「—」で出す。0 と区別できるようにするため */
function fmt(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}
