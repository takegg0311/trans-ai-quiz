/**
 * 音声なし問題の読み切り条件。
 *
 * 音声あり問題では全枠が押しても読み切りにしない（再生は最後まで続ける）。
 * 音声なしでは、全文を出し終えたとき、または ON の全枠が押したときに読み切る。
 */

export function shouldEndSilentReading(options: {
  hasAudio: boolean;
  shownLength: number;
  totalLength: number;
  activePressed: boolean[];
}): boolean {
  if (options.hasAudio) return false;
  if (options.totalLength > 0 && options.shownLength >= options.totalLength) {
    return true;
  }
  if (options.activePressed.length === 0) return false;
  return options.activePressed.every((pressed) => pressed);
}
