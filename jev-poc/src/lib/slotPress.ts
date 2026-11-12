/**
 * 枠の押下扱いと、白／灰の表示範囲。
 *
 * 押した扱いになる条件: 判定の基準位置（送信時点の文字数）で、まだ
 * 読まれていない文字が 1 文字でも残っていること。応答が読み切りの後に
 * 届いても、基準位置で文字が残っていれば押した扱いにする。
 * 基準位置が全文の長さと同じなら、押さなかった扱い。
 */

export type SlotDisplay = {
  /** 押したか */
  pressed: boolean;
  /**
   * 白で出す文字数（判定の基準位置）。
   * 押していないときは null（読み上げ中は呼び出し側が表示長を白で出す）。
   */
  whiteLength: number | null;
  /**
   * 灰まで含めた表示長（応答が届いた時点の表示位置）。
   * 押していない／読み切り灰のときは呼び出し側が決める。
   */
  grayLength: number | null;
};

/**
 * 応答が「押す」と出たときの表示を決める。
 *
 * @param judgedLength 判定の基準位置（送信時点の文字数）
 * @param arrivedLength 応答が届いた時点の表示文字数
 * @param totalLength 問題文の全文長
 */
export function resolvePress(
  judgedLength: number,
  arrivedLength: number,
  totalLength: number,
): SlotDisplay {
  // 基準位置が全文と同じなら、もう押す余地が無い
  if (judgedLength >= totalLength) {
    return { pressed: false, whiteLength: null, grayLength: null };
  }

  const whiteLength = Math.min(judgedLength, totalLength);
  const grayLength = Math.min(Math.max(arrivedLength, whiteLength), totalLength);
  return { pressed: true, whiteLength, grayLength };
}

/** 押さずに読み切ったときの表示（全文灰） */
export function readEndedDisplay(totalLength: number): SlotDisplay {
  return { pressed: false, whiteLength: null, grayLength: totalLength };
}
