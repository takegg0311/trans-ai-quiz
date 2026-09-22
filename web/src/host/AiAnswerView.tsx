/**
 * AI の回答の投影表示。
 *
 * **正解より早く、AI が押した直後（buzzed）から出す。** 正解ではないので
 * 投影を見ている参加者が読んでも得をせず、AI が押した時点でそのラウンドの
 * 解答権は確定している（ダブルチャンスは無い）。
 * どの phase で出すかはサーバが決めるため、ここでは受け取った内容を出す。
 *
 * 採用された回答だけでなく各モデルの応答も出す。どう決まったかが
 * 分からないと合議の妥当性を確かめられない。
 */
import type { AiAnswerView as AiAnswer } from '../protocol';

type Props = {
  /** 合議の結果。まだ固まっていなければ null */
  answer: AiAnswer | null;
  /** 回答待ちか。押した直後からここに出すため、待機中も枠を見せる */
  pending: boolean;
};

export function AiAnswerView({ answer, pending }: Props) {
  if (answer === null) {
    // 押した直後、合議が固まるまでの間。枠を先に出しておくことで、
    // 「AI が押した → 考えている → 答えが出た」の流れが投影で追える
    return (
      <section className="ai-answer">
        <h2 className="ai-answer-title">AI の回答</h2>
        <p className="ai-answer-main">
          <span className="ai-answer-none">{pending ? '考え中…' : '—'}</span>
        </p>
      </section>
    );
  }

  return (
    <section className="ai-answer">
      <h2 className="ai-answer-title">AI の回答</h2>

      <p className="ai-answer-main">
        {answer.answer === null ? (
          <span className="ai-answer-none">回答できませんでした</span>
        ) : (
          <strong>{answer.answer}</strong>
        )}
        {answer.reason !== '' && (
          <span className="ai-answer-reason">（{answer.reason}）</span>
        )}
      </p>

      {answer.models.length > 0 && (
        <table className="ai-answer-models">
          <tbody>
            {answer.models.map((model) => (
              <tr key={model.label}>
                <td className="ai-model-label">{model.label}</td>
                <td className="ai-model-answer">
                  {model.error != null && model.error !== '' ? (
                    <span className="ai-model-error">{model.error}</span>
                  ) : (
                    model.answer
                  )}
                </td>
                <td className="ai-model-ms">
                  {model.elapsed_ms > 0 ? `${model.elapsed_ms}ms` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
