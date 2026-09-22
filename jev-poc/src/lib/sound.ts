/**
 * ジングル SE の再生。
 *
 * ファイルは public/sound に配置されている（git 管理外）。
 */
const SOUND_DIR = '/sound';

export const JINGLE = {
  /** 出題時 */
  set: `${SOUND_DIR}/set.WAV`,
  /** 早押し時 */
  buzz: `${SOUND_DIR}/buzz.WAV`,
  correct: `${SOUND_DIR}/correct.WAV`,
  wrong: `${SOUND_DIR}/wrong.WAV`,
} as const;

export type JingleName = keyof typeof JINGLE;

/**
 * ジングルを再生し、再生完了で解決する Promise を返す。
 *
 * SE が未配置でも出題を止めないよう、再生に失敗した場合も reject せず解決する。
 */
export function playJingle(name: JingleName): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(JINGLE[name]);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    audio.addEventListener('ended', finish);
    audio.addEventListener('error', () => {
      console.warn(`[sound] ${JINGLE[name]} を再生できませんでした`);
      finish();
    });

    audio.play().catch((reason: unknown) => {
      console.warn(`[sound] ${JINGLE[name]} の再生が拒否されました`, reason);
      finish();
    });
  });
}
