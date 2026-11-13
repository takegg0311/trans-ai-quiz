/**
 * 問題一覧の読み込みと抽選。
 *
 * manifest.jev-poc.json はビルド前に scripts/build-manifest.ts が生成する。
 */
import { parseLab, type LabFile } from './lab';
import { buildAlignment, type Alignment } from './align';

const QUIZ_DATA_DIR = '/quiz_data';
const MANIFEST_PATH = `${QUIZ_DATA_DIR}/manifest.jev-poc.json`;

/** 音声なし問題の文字送り間隔（ms）。server の QUIZ_CHAR_INTERVAL_MS 既定と同じ */
export const SILENT_CHAR_INTERVAL_MS = 120;

export type ManifestEntry = {
  id: string;
  batch: string;
  seq: number;
  wav: string | null;
  txt: string | null;
  lab: string | null;
  text: string;
  answers: string[];
  hasAudio: boolean;
};

export type Question = {
  id: string;
  /** 音声ありなら URL。音声なしなら null */
  audioUrl: string | null;
  text: string;
  answers: string[];
  hasAudio: boolean;
  lab: LabFile | null;
  alignment: Alignment | null;
};

function encodePath(relativePath: string): string {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  return `${QUIZ_DATA_DIR}/${encoded}`;
}

export async function loadManifest(): Promise<ManifestEntry[]> {
  const response = await fetch(MANIFEST_PATH);
  if (!response.ok) {
    throw new Error(
      'manifest.jev-poc.json を読み込めませんでした。`npm run manifest` を実行してください。',
    );
  }
  const entries: unknown = await response.json();
  if (!Array.isArray(entries)) {
    throw new Error('manifest.jev-poc.json の形式が不正です。');
  }
  return entries as ManifestEntry[];
}

export async function loadQuestion(entry: ManifestEntry): Promise<Question> {
  if (!entry.hasAudio || entry.lab === null || entry.wav === null) {
    return {
      id: entry.id,
      audioUrl: null,
      text: entry.text.trim(),
      answers: entry.answers,
      hasAudio: false,
      lab: null,
      alignment: null,
    };
  }

  const response = await fetch(encodePath(entry.lab));
  if (!response.ok) throw new Error(`${entry.lab} を読み込めませんでした。`);

  const lab = parseLab(await response.text());
  const text = entry.text.trim();

  return {
    id: entry.id,
    audioUrl: encodePath(entry.wav),
    text,
    answers: entry.answers,
    hasAudio: true,
    lab,
    alignment: buildAlignment(text, lab),
  };
}

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
