/**
 * 問題一覧の読み込みと抽選。
 *
 * manifest.json はビルド前に scripts/build-manifest.ts が生成する。
 * バックエンドが無くブラウザからディレクトリ一覧を取得できないため。
 */
import { parseLab, type LabFile } from './lab';
import { buildAlignment, type Alignment } from './align';

const QUIZ_DATA_DIR = '/quiz_data';

export type ManifestEntry = {
  /** `{batch}/{seq}` 形式の問題 ID */
  id: string;
  batch: string;
  seq: number;
  wav: string;
  txt: string;
  lab: string;
  /** 問題文。questions.csv 由来 */
  text: string;
  /** 正解と別解。先頭が主たる正解 */
  answers: string[];
};

export type Question = {
  id: string;
  /** 音声ファイルの URL */
  audioUrl: string;
  text: string;
  answers: string[];
  lab: LabFile;
  alignment: Alignment;
};

/** manifest の相対パス（`{batch}/{seq}-{batch}.{ext}`）を URL にする */
function encodePath(relativePath: string): string {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  return `${QUIZ_DATA_DIR}/${encoded}`;
}

export async function loadManifest(): Promise<ManifestEntry[]> {
  const response = await fetch(`${QUIZ_DATA_DIR}/manifest.json`);
  if (!response.ok) {
    throw new Error(
      'manifest.json を読み込めませんでした。`npm run manifest` を実行してください。',
    );
  }
  const entries: unknown = await response.json();
  if (!Array.isArray(entries)) {
    throw new Error('manifest.json の形式が不正です。');
  }
  return entries as ManifestEntry[];
}

export async function loadQuestion(entry: ManifestEntry): Promise<Question> {
  // 問題文は manifest（questions.csv 由来）から取る。
  // txt との一致はビルド時に検証済みのため、ここで読み直さない。
  const response = await fetch(encodePath(entry.lab));
  if (!response.ok) throw new Error(`${entry.lab} を読み込めませんでした。`);

  const lab = parseLab(await response.text());
  const text = entry.text.trim();

  return {
    id: entry.id,
    audioUrl: encodePath(entry.wav),
    text,
    answers: entry.answers,
    lab,
    alignment: buildAlignment(text, lab),
  };
}

/**
 * 次の問題を 1 問選ぶ。
 * 直前と同じ問題が続くのを避けるため、候補が 2 問以上あるときは exclude を除外する。
 */
export function pickRandom(
  entries: ManifestEntry[],
  exclude?: string,
): ManifestEntry | undefined {
  if (entries.length === 0) return undefined;

  const candidates =
    entries.length > 1 && exclude !== undefined
      ? entries.filter((entry) => entry.id !== exclude)
      : entries;
  const pool = candidates.length > 0 ? candidates : entries;

  return pool[Math.floor(Math.random() * pool.length)];
}
