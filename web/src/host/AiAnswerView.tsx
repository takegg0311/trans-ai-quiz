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
 *
 * 各モデルが予測した問題文も、そのモデルの行の下に出す。答えが同じでも
 * 予測文はモデルごとに違うことがあり、1 つに代表させると恣意的になる。
 */
import { Fragment } from 'react';
import { splitContinuation } from '../lib/continuation';
import type { AiAnswerView as AiAnswer, AiModelAnswerView } from '../protocol';

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
            {answer.models.map((model) => {
              const continuation = continuationOf(model);
              return (
                <Fragment key={model.label}>
                  <tr>
                    <td className="ai-model-label">{model.label}</td>
                    <td className="ai-model-answer">
                      {model.pending === true ? (
                        // 早期確定で先に合議が決まった場合、残りはここに入る。
                        // 失敗と同じ見た目にすると「待っても来ない」と見える
                        <span className="ai-model-pending">応答待ち…</span>
                      ) : model.error != null && model.error !== '' ? (
                        <span className="ai-model-error">{model.error}</span>
                      ) : (
                        model.answer
                      )}
                    </td>
                    <td className="ai-model-ms">
                      {model.elapsed_ms > 0 ? `${model.elapsed_ms}ms` : ''}
                    </td>
                  </tr>
                  {continuation !== null && (
                    <tr>
                      <td />
                      <td className="ai-model-continuation" colSpan={2}>
                        <ContinuationText
                          continuation={continuation}
                          readText={answer.read_text}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** 予測した問題文。読み上げ済みの部分は薄く、予測で補った部分は強調する */
function ContinuationText({
  continuation,
  readText,
}: {
  continuation: string;
  readText: string;
}) {
  const split = splitContinuation(continuation, readText);
  if (split.kind === 'whole') {
    return <p className="ai-continuation">{split.text}</p>;
  }
  return (
    <p className="ai-continuation">
      <span className="ai-continuation-read">{split.read}</span>
      <span className="ai-continuation-predicted">{split.predicted}</span>
    </p>
  );
}

/**
 * 1 モデル分の予測文。出さない場合は null。
 * 違反・エラー・応答待ちには予測文が無い。成功でも返らないことがある
 */
function continuationOf(model: AiModelAnswerView): string | null {
  if (model.pending === true) return null;
  if (model.error != null && model.error !== '') return null;
  if (model.continuation == null || model.continuation === '') return null;
  return model.continuation;
}
