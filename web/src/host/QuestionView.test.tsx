/**
 * 投影用の問題文表示のテスト。
 *
 * 停止後に全文を見せる段では、読まれなかった残りを読み上げ済みの後ろへ
 * 灰色で続ける。残りの切り出しを誤ると、読まれていない文を読まれたように
 * 見せたり、同じ文を 2 回出したりするため固定する。
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QuestionView } from './QuestionView';

const FULL_TEXT = '日本で一番高い山は富士山ですが、二番目に高い山は何でしょう？';
const READ_TEXT = '日本で一番高い山は';

function renderQuestion(text: string, fullText: string | null) {
  const { container } = render(
    <QuestionView text={text} fullText={fullText} answers={null} judgement={null} />,
  );
  return {
    questionText: container.querySelector('.question-text'),
    rest: container.querySelector('.question-rest'),
  };
}

describe('QuestionView の残りの問題文', () => {
  it('読み上げ済みの後ろへ、残りを灰色の部分として続ける', () => {
    const { questionText, rest } = renderQuestion(READ_TEXT, FULL_TEXT);

    expect(rest?.textContent).toBe('富士山ですが、二番目に高い山は何でしょう？');
    // 別段落ではなく、問題文と同じ段落の中に続ける
    expect(questionText?.contains(rest ?? null)).toBe(true);
    expect(questionText?.textContent).toBe(FULL_TEXT);
  });

  it('全文を出さない段では残りを出さない', () => {
    const { questionText, rest } = renderQuestion(READ_TEXT, null);

    expect(rest).toBeNull();
    expect(questionText?.textContent).toBe(READ_TEXT);
  });

  it('読み切っていれば残りは無い', () => {
    const { rest } = renderQuestion(FULL_TEXT, FULL_TEXT);

    expect(rest).toBeNull();
  });

  it('表示中の文が全文の先頭と一致しなければ残りを出さない', () => {
    // 残りを取り違えて、読まれていない文を読まれたように見せないため
    const { rest } = renderQuestion('日本一高い山は', FULL_TEXT);

    expect(rest).toBeNull();
  });
});
