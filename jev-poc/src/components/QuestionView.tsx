type Props = {
  /** 再生位置まで表示された問題文 */
  text: string;
};

export function QuestionView({ text }: Props) {
  return (
    <div className="question-view">
      <p className="question-text">
        {text}
        <span className="cursor" aria-hidden="true" />
      </p>
    </div>
  );
}
