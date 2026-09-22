/**
 * AI の回答の表示。
 *
 * 3 モデルそれぞれの答えと応答時間、および合議でどれが採用されたかを出す。
 * 採用された答えだけを見せると「なぜその答えになったか」が分からず、
 * 合議の規則を調整する手がかりが残らない。
 */
import { describeConsensus, type Consensus } from '../lib/consensus';
import { OPPONENTS, type SlotState } from '../lib/useAiAnswer';

type Props = {
  slots: SlotState[];
  consensus: Consensus | null;
  /** AI の答えが正解だったか。回答待ちと全滅では null */
  correct: boolean | null;
  /** LLM が使える状態か。使えない場合は理由を出す */
  available: boolean;
};

export function AiAnswerView({ slots, consensus, correct, available }: Props) {
  const pending = slots.some((slot) => slot.state === 'pending');

  return (
    <section className="ai-answer">
      <header className="ai-answer-header">
        <h2>AI の回答</h2>
        {pending && <span className="ai-answer-pending">考え中…</span>}
      </header>

      <table className="ai-answer-table">
        <thead>
          <tr>
            <th>モデル</th>
            <th>回答</th>
            <th>ms</th>
          </tr>
        </thead>
        <tbody>
          {OPPONENTS.map((opponent, index) => {
            const slot = slots[index];
            const adopted =
              consensus?.supporters.some((s) => s.model === opponent.model) === true;
            return (
              <tr key={opponent.model} className={adopted ? 'ai-adopted' : undefined}>
                <td>{opponent.label}</td>
                <td>{describeSlot(slot)}</td>
                <td>{slot?.state === 'done' ? slot.result.elapsedMs : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {!available && (
        <p className="notice">
          LLM に接続できないため AI は回答できません。
          server の起動と API キー（Claude / Gemini / Grok）を確認してください。
        </p>
      )}

      {consensus !== null && (
        <p className={`ai-answer-result ${correct === true ? 'is-correct' : 'is-wrong'}`}>
          {consensus.answer === null ? (
            <>AI は回答できませんでした（{describeConsensus(consensus)}）</>
          ) : (
            <>
              AI の回答: <strong>{consensus.answer}</strong>{' '}
              {correct === true ? '○' : '×'}
              <span className="ai-answer-reason">（{describeConsensus(consensus)}）</span>
              {lateArrivals(slots, consensus) > 0 && (
                <span className="ai-answer-reason">
                  {' '}
                  ※ 確定後に {lateArrivals(slots, consensus)} 件到着
                </span>
              )}
            </>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * 合議が確定した後に届いた応答の数。
 *
 * 採用票（supporters）は確定時点の記録であり、後から届いた回答では
 * 書き換えない。確定は 2 票で決まったという事実が消えてしまうため。
 * 代わりに「確定後に N 件到着」と添えて、表と票の食い違いを説明する。
 */
function lateArrivals(slots: SlotState[], consensus: Consensus): number {
  if (consensus.answer === null) return 0;
  const done = slots.filter((slot) => slot.state === 'done').length;
  return Math.max(0, done - consensus.participants);
}

/** 1 モデル分の表示。失敗は種別まで出す */
function describeSlot(slot: SlotState | undefined): string {
  if (slot === undefined || slot.state === 'idle') return '—';
  if (slot.state === 'pending') return '…';

  switch (slot.result.status) {
    case 'ok':
      return slot.result.answer;
    case 'violation':
      return `違反: ${slot.result.violation}`;
    case 'error':
      return `エラー: ${slot.result.message}`;
  }
}
