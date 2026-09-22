/**
 * 音声の再生位置から「問題文を何文字目まで表示すべきか」を求める。
 *
 * 音素列（.lab）と日本語表記（.txt）は文字数が対応しない（例: 「日本」= n i cl p o N）。
 * ブラウザ内で形態素解析なしに厳密なアライメントは解けないため、次の方式を採る:
 *
 *   1. .lab の無音（pau）で音声を発話チャンクに分割する
 *   2. .txt を読点・句点で同数のチャンクに分割し、順に対応付ける
 *   3. チャンク内部は、そのチャンクの時間幅に対する経過時間の比例配分で文字を送る
 *
 * pau は問題文の読点位置とよく一致するため、チャンク境界では表示が実際の読みに追従する。
 *
 * ただし pau は読点位置だけでなく文中の息継ぎにも現れるため、1. と 2. の個数は
 * しばしば一致しない。そのまま先頭から対応付けると読点でない pau が境界として
 * 採用され、表示が音声から大きくずれる。そこで数が合わない場合は、多い側を
 * 少ない側の個数へ統合してから対応付ける（mergeSegments / mergeTextChunks を参照）。
 *
 * より高精度な方式（読み仮名を付与して音素列とアライメント）へ差し替えられるよう、
 * 同期ロジックはこのモジュールに閉じ込めてある。外部へ公開するのは buildAlignment と
 * visibleLength のみで、この 2 つの契約さえ保てば内部方式は入れ替えられる。
 */
import type { LabFile, SpeechSegment } from './lab';

/** チャンク境界とみなす文字。VOICEPEAK の読み上げはこれらの位置で pau が入りやすい */
const CHUNK_DELIMITERS = /[、。，．？！?!]/;

/**
 * チャンク内部の 1 発話区間。統合で 1 チャンクにまとめた pau 区切りの単位で、
 * この粒度で文字を配分すると、チャンク内に無音を含む場合でも表示が読みに追従する。
 */
type AlignedPart = {
  /** 開始時刻（秒） */
  start: number;
  /** 終了時刻（秒） */
  end: number;
  /** 問題文全体における、この区間開始時点の表示済み文字数 */
  charStart: number;
  /** 問題文全体における、この区間終了時点の表示済み文字数 */
  charEnd: number;
};

/** 対応付けられた 1 チャンク分の情報 */
type AlignedChunk = {
  /** このチャンクが始まる時刻（秒） */
  start: number;
  /** このチャンクが終わる時刻（秒） */
  end: number;
  /** 問題文全体における、このチャンク開始時点の表示済み文字数 */
  charStart: number;
  /** 問題文全体における、このチャンク終了時点の表示済み文字数 */
  charEnd: number;
  /**
   * チャンクを構成する発話区間。統合していない場合は 1 要素。
   * 区間の切れ目（無音）では文字を進めないため、複数要素になることがある。
   */
  parts: AlignedPart[];
};

export type Alignment = {
  /** 問題文全文 */
  text: string;
  chunks: AlignedChunk[];
};

/**
 * 問題文を区切り文字で分割する。区切り文字は直前のチャンクへ含める
 * （「〜ですが、」までで 1 チャンクとしたいため）。
 */
function splitTextIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const char of text) {
    current += char;
    if (CHUNK_DELIMITERS.test(char)) {
      chunks.push(current);
      current = '';
    }
  }
  if (current !== '') chunks.push(current);

  return chunks.filter((chunk) => chunk.trim() !== '');
}

/**
 * 統合しても残したい境界を、区間の隙間（pau）が長い順に count 個選ぶ。
 *
 * 返すのは「その要素の直前で区切る」インデックスの集合。読点相当の pau は
 * 文中の息継ぎより有意に長い、という性質を利用している。長さが同じ隙間が
 * 並んだ場合は前方を優先し、結果が入力順で安定するようにしている。
 */
function pickBoundaries(segments: SpeechSegment[], count: number): Set<number> {
  const gaps = segments.slice(1).map((segment, index) => ({
    // segments[index + 1] の直前で区切る
    index: index + 1,
    length: segment.start - segments[index]!.end,
  }));

  gaps.sort((a, b) => b.length - a.length || a.index - b.index);

  return new Set(gaps.slice(0, count).map((gap) => gap.index));
}

/**
 * 発話区間を targetCount 個のグループへ統合する。
 *
 * 文中の息継ぎで生じた短い pau を境界から外し、読点相当の長い pau だけを
 * 残すことで、文字側のチャンクと 1 対 1 に対応させる。
 *
 * 統合しても元の区間は捨てず、グループ（= チャンク）を構成する区間の配列として返す。
 * 吸収した pau の位置で文字を止めるため、この情報を後段の配分で使う。
 */
function mergeSegments(segments: SpeechSegment[], targetCount: number): SpeechSegment[][] {
  if (segments.length <= targetCount) return segments.map((segment) => [segment]);

  const boundaries = pickBoundaries(segments, targetCount - 1);
  const merged: SpeechSegment[][] = [];
  let current: SpeechSegment[] = [segments[0]!];

  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (boundaries.has(i)) {
      merged.push(current);
      current = [segment];
    } else {
      // 境界にしない pau はチャンクの内部に残す（文字はそこで進めない）
      current.push(segment);
    }
  }
  merged.push(current);

  return merged;
}

/**
 * 文字チャンクを targetCount 個へ統合する。
 *
 * 音声側の区間のほうが少ない場合に使う。どの読点が pau になっていないかは
 * 文字列からは判断できないため、文字数の均等さを手掛かりに、結合しても
 * 最も偏りが小さくなる位置から順に隣接チャンクをまとめる。
 */
function mergeTextChunks(textChunks: string[], targetCount: number): string[] {
  if (textChunks.length <= targetCount) return textChunks;

  const merged = [...textChunks];
  while (merged.length > targetCount) {
    let bestIndex = 0;
    let bestLength = Infinity;

    // 結合後がいちばん短くなる隣接ペアを選ぶ
    for (let i = 0; i + 1 < merged.length; i += 1) {
      const length = [...merged[i]!].length + [...merged[i + 1]!].length;
      if (length < bestLength) {
        bestLength = length;
        bestIndex = i;
      }
    }

    merged.splice(bestIndex, 2, merged[bestIndex]! + merged[bestIndex + 1]!);
  }

  return merged;
}

/**
 * 音声側の発話区間と文字側のチャンクを対応付ける。
 *
 * 個数が食い違う場合は、多い側を少ない側の個数へ統合してから 1 対 1 に対応付ける。
 * 先頭から順に対応付けて余りを最終チャンクへ吸収する方式では、読点でない pau が
 * 境界として採用され、表示が音声から大きくずれるため。
 */
export function buildAlignment(text: string, lab: LabFile): Alignment {
  const normalizedText = text.trim();
  const textChunks = splitTextIntoChunks(normalizedText);
  const segments = lab.segments;

  // どちらかが空なら、全体を 1 チャンクとして時間比例で送る
  if (textChunks.length === 0 || segments.length === 0) {
    const end = lab.duration > 0 ? lab.duration : 1;
    const charEnd = [...normalizedText].length;
    return {
      text: normalizedText,
      chunks: [
        {
          start: 0,
          end,
          charStart: 0,
          charEnd,
          parts: [{ start: 0, end, charStart: 0, charEnd }],
        },
      ],
    };
  }

  const pairCount = Math.min(textChunks.length, segments.length);
  const pairedSegments = mergeSegments(segments, pairCount);
  const pairedTextChunks = mergeTextChunks(textChunks, pairCount);

  const chunks: AlignedChunk[] = [];
  let charCursor = 0;

  for (let i = 0; i < pairCount; i += 1) {
    const parts = pairedSegments[i]!;
    const charCount = [...pairedTextChunks[i]!].length;
    const charEnd = charCursor + charCount;

    chunks.push({
      start: parts[0]!.start,
      end: parts.at(-1)!.end,
      charStart: charCursor,
      charEnd,
      parts: distributeChars(parts, charCursor, charCount),
    });
    charCursor = charEnd;
  }

  return { text: normalizedText, chunks };
}

/**
 * チャンクの文字数を、内部の発話区間へ配分する。
 *
 * 配分は各区間の発話時間の比で行う（無音は含めない）。区間をまたぐ長さの
 * 偏りを吸収するためで、均等に割ると、短く発話される区間で文字が先行する。
 *
 * 端数は切り捨てで積み上げ、最後の区間へ寄せる。文字数の総和は必ず charCount に一致する。
 */
function distributeChars(
  parts: SpeechSegment[],
  charStart: number,
  charCount: number,
): AlignedPart[] {
  const totalSpeech = parts.reduce((sum, part) => sum + (part.end - part.start), 0);
  const aligned: AlignedPart[] = [];
  let cursor = charStart;
  let consumed = 0;

  parts.forEach((part, index) => {
    const isLast = index === parts.length - 1;
    // 発話時間が 0 の異常データでは均等割りへ退避する
    const ratio = totalSpeech > 0 ? (part.end - part.start) / totalSpeech : 1 / parts.length;
    const count = isLast ? charCount - consumed : Math.floor(charCount * ratio);

    aligned.push({
      start: part.start,
      end: part.end,
      charStart: cursor,
      charEnd: cursor + count,
    });
    cursor += count;
    consumed += count;
  });

  return aligned;
}

/**
 * 再生位置 currentTime（秒）において表示すべき文字数を返す。
 *
 * 無音区間にいる場合は、直前に読み終えた位置を保つ。文字だけが先に進んで
 * 見えるのを防ぐため。これはチャンクの間だけでなく、チャンク内部に残った
 * 短い pau についても同じように扱う。
 */
export function visibleLength(alignment: Alignment, currentTime: number): number {
  const { chunks } = alignment;
  if (chunks.length === 0) return 0;

  const first = chunks[0]!;
  if (currentTime <= first.start) return 0;

  const last = chunks.at(-1)!;
  if (currentTime >= last.end) return last.charEnd;

  for (const chunk of chunks) {
    if (currentTime >= chunk.end) continue;

    // チャンク間の無音区間にいる: 直前のチャンクまで表示した状態で待つ
    if (currentTime < chunk.start) return chunk.charStart;

    for (const part of chunk.parts) {
      if (currentTime >= part.end) continue;

      // チャンク内部の無音区間にいる: 直前の区間まで表示した状態で待つ
      if (currentTime < part.start) return part.charStart;

      const span = part.end - part.start;
      if (span <= 0) return part.charEnd;

      const progress = (currentTime - part.start) / span;
      const charCount = part.charEnd - part.charStart;
      return part.charStart + Math.floor(progress * charCount);
    }

    return chunk.charEnd;
  }

  return last.charEnd;
}

/** 表示すべき文字数ぶんだけ切り出す。サロゲートペアを壊さないよう配列経由で扱う */
export function visibleText(alignment: Alignment, currentTime: number): string {
  const length = visibleLength(alignment, currentTime);
  return [...alignment.text].slice(0, length).join('');
}
