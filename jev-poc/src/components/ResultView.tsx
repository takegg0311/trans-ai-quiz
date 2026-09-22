type Props = {
  correct: boolean;
  input: string;
  /** 表示用の正解文字列 */
  answer: string;
  /** 問題文の全文 */
  fullText: string;
  onNext: () => void;
};

export function ResultView({ correct, input, answer, fullText, onNext }: Props) {
  return (
    <div className={`result-view ${correct ? 'is-correct' : 'is-wrong'}`}>
      <p className="result-mark" aria-hidden="true">
        {correct ? '○' : '×'}
      </p>
      <p className="result-label">{correct ? '正解！' : '不正解…'}</p>
      <dl className="result-detail">
        <dt>あなたの回答</dt>
        <dd>{input}</dd>
        <dt>正解</dt>
        <dd>{answer}</dd>
      </dl>
      <p className="result-full-text">{fullText}</p>
      <button type="button" className="next-button" onClick={onNext}>
        次へ
      </button>
    </div>
  );
}
