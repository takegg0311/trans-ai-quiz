/**
 * 判定比較の 1 枠。左に問題文（白／灰）、右にトグルとゲージ。
 */
import { ASKING_MIN, BUZZ_WEAK } from '../lib/decision';
import type { JudgeProviderInfo } from '../lib/judge';
import type { ProviderId } from '../lib/providerPrefs';
import { PROVIDER_LABELS } from '../lib/providerPrefs';
import type { SlotState } from '../lib/useSlotJudge';

type Props = {
  provider: ProviderId;
  info: JudgeProviderInfo | undefined;
  /** 画面に出す実効 ON */
  enabled: boolean;
  /** トグルを変えられるか（待機中かつ available） */
  toggleable: boolean;
  available: boolean;
  fullText: string;
  readingLength: number;
  slot: SlotState;
  onToggle: (value: boolean) => void;
};

export function ProviderSlot({
  provider,
  info,
  enabled,
  toggleable,
  available,
  fullText,
  readingLength,
  slot,
  onToggle,
}: Props) {
  const label = info?.label ?? PROVIDER_LABELS[provider];
  const model = info?.model ?? '';
  const text = splitSlotText(fullText, slot, readingLength);

  return (
    <section className={`provider-slot${enabled ? '' : ' is-off'}`}>
      <div className="provider-slot-text">
        {enabled ? (
          <p className="provider-slot-question">
            {text.white}
            {text.gray !== '' && (
              <span className="provider-slot-gray">{text.gray}</span>
            )}
            <span className="cursor" aria-hidden="true" />
          </p>
        ) : (
          <p className="provider-slot-empty" />
        )}
      </div>

      <aside className="provider-slot-side">
        <header className="provider-slot-header">
          <div>
            <h2>{label}</h2>
            <p className="provider-slot-model">{model || '—'}</p>
          </div>
          <label className="provider-slot-toggle">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!toggleable}
              onChange={(event) => onToggle(event.target.checked)}
            />
            {enabled ? 'ON' : 'OFF'}
          </label>
        </header>

        {!available && info?.reason && (
          <p className="provider-slot-reason">{info.reason}</p>
        )}

        {enabled && slot.error && (
          <p className="provider-slot-error">{slot.error}</p>
        )}

        {enabled && (
          <div className="provider-slot-gauges">
            <Gauge label="buzz" value={slot.judgement?.buzz ?? null} threshold={BUZZ_WEAK} />
            <Gauge
              label="asking"
              value={slot.judgement?.asking ?? null}
              threshold={ASKING_MIN}
            />
            <Gauge
              label="parallel"
              value={slot.judgement?.parallel ?? null}
              threshold={null}
            />
          </div>
        )}

        {enabled && slot.display?.pressed && slot.judgement && (
          <p className="provider-slot-pressed">
            {slot.display.whiteLength} 字で押下: {slot.judgement.reason}
          </p>
        )}
      </aside>
    </section>
  );
}

/** 白（基準位置）と灰（応答到達〜）の範囲に問題文を分ける */
export function splitSlotText(
  fullText: string,
  slot: SlotState,
  readingLength: number,
): { white: string; gray: string } {
  const chars = [...fullText];
  const display = slot.display;

  if (display?.pressed && display.whiteLength !== null) {
    const whiteEnd = display.whiteLength;
    const grayEnd = display.grayLength ?? whiteEnd;
    return {
      white: chars.slice(0, whiteEnd).join(''),
      gray: chars.slice(whiteEnd, grayEnd).join(''),
    };
  }

  if (display && !display.pressed && display.grayLength !== null) {
    return { white: '', gray: chars.slice(0, display.grayLength).join('') };
  }

  const end = Math.min(slot.liveLength || readingLength, chars.length);
  return { white: chars.slice(0, end).join(''), gray: '' };
}

function Gauge({
  label,
  value,
  threshold,
}: {
  label: string;
  value: number | null;
  threshold: number | null;
}) {
  const filled = value === null ? 0 : Math.min(Math.max(value, 0), 1);
  const reached = threshold !== null && value !== null && value >= threshold;

  return (
    <div className="slot-gauge">
      <span className="slot-gauge-label">{label}</span>
      <span className="slot-gauge-track">
        <span
          className={`slot-gauge-fill${reached ? ' is-reached' : ''}`}
          style={{ width: `${filled * 100}%` }}
        />
        {threshold !== null && (
          <span
            className="slot-gauge-threshold"
            style={{ left: `${threshold * 100}%` }}
            aria-hidden="true"
          />
        )}
      </span>
      <span className="slot-gauge-value">
        {value === null ? '—' : value.toFixed(2)}
      </span>
    </div>
  );
}
