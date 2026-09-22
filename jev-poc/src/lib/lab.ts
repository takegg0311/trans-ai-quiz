/**
 * VOICEPEAK が出力する HTK 形式の音素ラベル（.lab）を読む。
 *
 * 各行は `開始 終了 音素` で、時刻の単位は 100ns（= 1e-7 秒）。
 * 無音区間は音素 `pau` で表され、これが問題文の読点位置とよく一致するため、
 * 音声と問題文を対応付けるチャンク境界として利用する（align.ts を参照）。
 */

/** HTK の時刻単位。1 秒 = 10,000,000 */
const HTK_UNITS_PER_SECOND = 10_000_000;

/** 無音を表す音素 */
const SILENCE_PHONEME = 'pau';

export type Phoneme = {
  /** 開始時刻（秒） */
  start: number;
  /** 終了時刻（秒） */
  end: number;
  phoneme: string;
  /** 無音区間かどうか */
  isSilence: boolean;
};

/** 発話が連続している区間。無音（pau）で挟まれた 1 かたまり */
export type SpeechSegment = {
  /** 開始時刻（秒） */
  start: number;
  /** 終了時刻（秒） */
  end: number;
};

export type LabFile = {
  phonemes: Phoneme[];
  /** 無音を除いた発話区間の並び。問題文チャンクとの対応付けに使う */
  segments: SpeechSegment[];
  /** ラベル上の総再生時間（秒） */
  duration: number;
};

export function parseLab(text: string): LabFile {
  const phonemes: Phoneme[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;

    const columns = line.split(/\s+/);
    if (columns.length < 3) continue;

    const start = Number(columns[0]);
    const end = Number(columns[1]);
    const phoneme = columns[2]!;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    phonemes.push({
      start: start / HTK_UNITS_PER_SECOND,
      end: end / HTK_UNITS_PER_SECOND,
      phoneme,
      isSilence: phoneme === SILENCE_PHONEME,
    });
  }

  return {
    phonemes,
    segments: toSpeechSegments(phonemes),
    duration: phonemes.at(-1)?.end ?? 0,
  };
}

/** 連続する非無音の音素をまとめ、発話区間の並びにする */
function toSpeechSegments(phonemes: Phoneme[]): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  let current: SpeechSegment | null = null;

  for (const phoneme of phonemes) {
    if (phoneme.isSilence) {
      if (current !== null) {
        segments.push(current);
        current = null;
      }
      continue;
    }
    if (current === null) {
      current = { start: phoneme.start, end: phoneme.end };
    } else {
      current.end = phoneme.end;
    }
  }
  if (current !== null) segments.push(current);

  return segments;
}
