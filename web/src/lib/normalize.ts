/**
 * 回答の比較用正規化。
 *
 * オンライン版は**正誤判定を行わない**。判定は出題者が口頭回答を聞いて
 * 押すものであり、`web/` にも `server/` にも照合ロジックは無い。
 * そのため `jev-poc` の answer.ts は移植せず、正規化だけをここへ置く。
 *
 * 使うのは合議（consensus.ts）で「モデル間の回答が同じか」を比べるときだけ。
 * 表記揺れで多数決が割れると、実質同じ答えなのに最速採用へ落ちてしまう。
 */

/** 全角英数字を半角へ寄せる */
function toHalfWidth(value: string): string {
  return value.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );
}

/**
 * 全角/半角・大文字小文字・空白・記号の揺れを吸収する。
 *
 * 括弧類も落とす。LLM は作品名を『檸檬』「檸檬」のように括って返すことが
 * あり、括弧を残すと実質同じ答えなのに別グループへ分かれる
 * （実測: Claude と Grok が 檸檬、Gemini が 『檸檬』）。
 */
export function normalizeAnswer(value: string): string {
  return toHalfWidth(value.normalize('NFKC'))
    .toLowerCase()
    .replace(/[\s・･\-ー―‐]/g, '')
    .replace(/[「」『』（）()[\]【】〈〉《》"'”’]/g, '');
}
