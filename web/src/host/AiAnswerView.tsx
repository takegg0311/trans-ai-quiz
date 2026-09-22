/**
 * AI の回答の投影表示。
 *
 * 正解が出るのと同じ phase（check / timeUp / result）でのみ表示される。
 * サーバが room_state に載せる段階で制御しているため、ここでは
 * 受け取った内容をそのまま出す。
 *
 * 採用された回答だけでなく各モデルの応答も出す。どう決まったかが
 * 分からないと合議の妥当性を確かめられない。
 */
import type { AiAnswerView as AiAnswer } from '../protocol';

type Props = {
  answer: AiAnswer;
};

export function AiAnswerView({ answer }: Props) {
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
