/**
 * 正誤判定。
 *
 * 正解と別解は questions.csv の `answer` / `alt_answers` 列で管理し、
 * manifest.json の `answers`（先頭が主たる正解）として渡ってくる。
 *
 * 判定は正規化した上での部分一致とする（PoC のため緩めに取る）。
 */

/** 全角英数字を半角へ寄せる */
function toHalfWidth(value: string): string {
  return value.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );
}

/**
 * 比較用の正規化。
 * 全角/半角・大文字小文字・空白・記号の揺れを吸収する。
 */
function normalize(value: string): string {
  return toHalfWidth(value.normalize('NFKC'))
    .toLowerCase()
    .replace(/[\s・･\-ー―‐]/g, '');
}

/** 入力が正解候補のいずれかと部分一致するか */
export function isCorrect(input: string, answers: string[]): boolean {
  const normalizedInput = normalize(input);
  if (normalizedInput === '') return false;

  return answers.some((answer) => {
    const normalizedAnswer = normalize(answer);
    if (normalizedAnswer === '') return false;
    return (
      normalizedInput.includes(normalizedAnswer) ||
      normalizedAnswer.includes(normalizedInput)
    );
  });
}

/** 表示用の正解文字列。別解があれば併記する */
export function formatAnswer(answers: string[]): string {
  return answers.join(' / ');
}
