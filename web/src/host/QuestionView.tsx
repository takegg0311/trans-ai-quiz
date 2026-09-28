/**
 * 投影用の問題文表示。読み上げに追従して文字が増えていく。
 *
 * 停止後に全文を見せる段では、読み上げ済みの問題文の後ろへ残りを灰色で続ける。
 * 別の段落に全文を出し直すと、同じ文が 2 回並んでどこで止まったかが追いにくい。
 * カーソルは止まった位置（読み上げ済みと残りの境目）に残す。
 */
import type { JudgementView } from '../protocol';

type Props = {
  /** 現在表示すべきところまで切り出した問題文 */
  text: string;
  /** 停止後に全文を見せる場合の全文。表示しないときは null */
  fullText: string | null;
  /** 正解。まだ出してよい phase でないときは null */
  answers: string[] | null;
  judgement: JudgementView | null;
};

export function QuestionView({ text, fullText, answers, judgement }: Props) {
  // 表示中の文は全文の先頭から切り出したものなので、通常は前方一致する。
  // 万一一致しなければ、残りを取り違えないよう続けて出さない
  const rest =
    fullText !== null && fullText.startsWith(text) ? fullText.slice(text.length) : '';

  return (
    <div className="question">
      <p className="question-text">
        {text}
        <span className="question-caret" />
        {rest !== '' && <span className="question-rest">{rest}</span>}
      </p>

      {answers !== null && answers.length > 0 && (
        <p className="question-answer">
          <span className="question-answer-label">正解</span>
          {answers.join(' / ')}
        </p>
      )}

      {judgement !== null && (
        <p className={judgement.correct ? 'judgement correct' : 'judgement wrong'}>
          {judgement.name} さん {judgement.correct ? '正解' : '不正解'}
        </p>
      )}
    </div>
  );
}
