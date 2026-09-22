type Props = {
  /** 再生位置まで表示された問題文 */
  text: string;
  /**
   * Jev が押すと判断した時点の文字数。手動早押しと読み上げ中は null。
   *
   * 判定から押下までの間にも読み上げは進むため、この位置より後ろは
   * 「Jev が見ていなかった文字」である。灰色で示し、判定の根拠になった
   * 範囲と、遅れのぶん読まれてしまった範囲を区別する。
   */
  judgedLength?: number | null;
};

export function QuestionView({ text, judgedLength = null }: Props) {
  const chars = [...text];
  // 判定位置が表示長を超えることはないが、超えた場合も壊れないようにする
  const split =
    judgedLength === null ? chars.length : Math.min(judgedLength, chars.length);

  const judged = chars.slice(0, split).join('');
  const afterJudged = chars.slice(split).join('');

  return (
    <div className="question-view">
      <p className="question-text">
        {judged}
        {afterJudged !== '' && (
          <span className="question-after-judged">{afterJudged}</span>
        )}
        <span className="cursor" aria-hidden="true" />
      </p>
    </div>
  );
}
