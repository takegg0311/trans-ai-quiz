/**
 * questions.csv から jev-poc 用 manifest を組み立てる核。
 *
 * 音声あり／なしの規則は server/app/quiz.py と同じ。
 * 出力先を manifest.json と分けるのは、凍結 poc/ と共有すると
 * 音声なし行の扱いで片方の manifest を壊すため。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REQUIRED_EXTENSIONS = ['.wav', '.txt', '.lab'] as const;
export const CANDIDATE_WIDTHS = [1, 2, 3] as const;
const ALT_ANSWER_SEPARATOR = '|';
const CSV_COLUMNS = ['batch', 'seq', 'text', 'answer', 'alt_answers'] as const;
type ColumnName = (typeof CSV_COLUMNS)[number];
type Row = Record<ColumnName, string>;

export type ManifestEntry = {
  id: string;
  batch: string;
  seq: number;
  /** 音声ありなら相対パス。音声なしなら null */
  wav: string | null;
  txt: string | null;
  lab: string | null;
  text: string;
  answers: string[];
  hasAudio: boolean;
};

export function questionFilePath(
  batch: string,
  seq: number,
  ext: string,
  width = 1,
): string {
  return `${batch}/${String(seq).padStart(width, '0')}-${batch}${ext}`;
}

export function seqWidth(count: number): number {
  return String(Math.max(count, 1)).length;
}

export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let hasField = false;

  const endField = () => {
    row.push(field);
    field = '';
    hasField = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !hasField) {
      inQuotes = true;
      hasField = true;
      continue;
    }
    if (char === ',') {
      endField();
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      endRow();
      continue;
    }
    field += char;
    hasField = true;
  }
  if (field !== '' || hasField || row.length > 0) endRow();
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

function toRows(cells: string[][]): Row[] {
  const [header, ...dataRows] = cells;
  if (header === undefined) throw new Error('questions.csv が空です。');

  const headerNames = header.map((name) => name.trim());
  const missing = CSV_COLUMNS.filter((name) => !headerNames.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `questions.csv のヘッダに ${missing.join(', ')} がありません。` +
        `期待する列: ${CSV_COLUMNS.join(', ')}`,
    );
  }

  return dataRows.map((cells) => {
    const row = {} as Row;
    for (const name of CSV_COLUMNS) {
      row[name] = (cells[headerNames.indexOf(name)] ?? '').trim();
    }
    return row;
  });
}

function toAnswers(row: Row): string[] {
  const alternatives = row.alt_answers
    .split(ALT_ANSWER_SEPARATOR)
    .map((value) => value.trim())
    .filter((value) => value !== '');
  return [row.answer, ...alternatives];
}

function probeWidth(
  quizDataDir: string,
  batch: string,
  seq: number,
  width: number,
): { found: Record<string, string>; missing: string[] } {
  const found: Record<string, string> = {};
  const missing: string[] = [];
  for (const ext of REQUIRED_EXTENSIONS) {
    const relativePath = questionFilePath(batch, seq, ext, width);
    if (existsSync(join(quizDataDir, relativePath))) {
      found[ext] = relativePath;
    } else {
      missing.push(ext);
    }
  }
  return { found, missing };
}

/**
 * quiz.py の _find_audio_paths と同じ規則。
 *
 * - 想定桁に 1 つでもあればその結果（一部だけならエラー用に返す）
 * - 想定桁が空のときだけ他桁を見る。3 点そろい優先
 * - どの桁にも無ければ音声なし
 */
export function findAudioPaths(
  quizDataDir: string,
  batch: string,
  seq: number,
  width: number,
): { found: Record<string, string>; missing: string[] } {
  const atWidth = probeWidth(quizDataDir, batch, seq, width);
  if (Object.keys(atWidth.found).length > 0) return atWidth;

  let partial: { found: Record<string, string>; missing: string[] } | null = null;
  for (const candidate of CANDIDATE_WIDTHS) {
    if (candidate === width) continue;
    const probed = probeWidth(quizDataDir, batch, seq, candidate);
    const foundCount = Object.keys(probed.found).length;
    if (foundCount > 0 && probed.missing.length === 0) return probed;
    if (foundCount > 0 && partial === null) partial = probed;
  }
  if (partial !== null) return partial;
  return { found: {}, missing: [...REQUIRED_EXTENSIONS] };
}

function toEntry(
  quizDataDir: string,
  row: Row,
  lineNumber: number,
  errors: string[],
  width: number,
): ManifestEntry | undefined {
  const label = `${lineNumber} 行目`;
  const before = errors.length;

  if (row.batch === '') errors.push(`${label}: batch が空です。`);
  if (row.seq === '') errors.push(`${label}: seq が空です。`);
  if (row.text === '') errors.push(`${label}: text が空です。`);
  if (row.answer === '') errors.push(`${label}: answer が空です。`);

  const seq = Number(row.seq);
  if (row.seq !== '' && (!Number.isInteger(seq) || seq < 0)) {
    errors.push(`${label}: seq は 0 以上の整数である必要があります（${row.seq}）。`);
  }
  if (row.text.includes('\n')) {
    errors.push(`${label}: text に改行を含められません（1 問 1 ブロック）。`);
  }
  if (errors.length > before) return undefined;

  const id = `${row.batch}/${seq}`;
  const { found, missing } = findAudioPaths(quizDataDir, row.batch, seq, width);

  if (Object.keys(found).length > 0 && missing.length > 0) {
    const foundNames = Object.values(found).sort().join(', ');
    errors.push(
      `${label} (${id}): 音声ファイルが揃っていません。` +
        `${missing.join(', ')} が見つかりません（${foundNames} はあります）。\n` +
        `    3 点すべて揃えるか、3 点とも置かない（音声なし問題）にしてください。`,
    );
    return undefined;
  }

  if (Object.keys(found).length > 0) {
    const txtContent = readFileSync(join(quizDataDir, found['.txt']!), 'utf8').trim();
    if (txtContent !== row.text) {
      errors.push(
        `${label} (${id}): text が ${found['.txt']} と一致しません。\n` +
          `    CSV: ${row.text}\n` +
          `    TXT: ${txtContent}`,
      );
      return undefined;
    }
  }

  const hasAudio = Object.keys(found).length === REQUIRED_EXTENSIONS.length;
  return {
    id,
    batch: row.batch,
    seq,
    wav: found['.wav'] ?? null,
    txt: found['.txt'] ?? null,
    lab: found['.lab'] ?? null,
    text: row.text,
    answers: toAnswers(row),
    hasAudio,
  };
}

/** CSV 文字列から Entry 一覧を作る。失敗時は Error を投げる */
export function buildEntries(quizDataDir: string, source: string): ManifestEntry[] {
  const rows = toRows(parseCsv(source));
  const errors: string[] = [];
  const entries: ManifestEntry[] = [];
  const seenIds = new Map<string, number>();

  const maxSeq = new Map<string, number>();
  for (const row of rows) {
    const seq = Number(row.seq);
    if (row.seq === '' || !Number.isInteger(seq) || seq < 0) continue;
    if (seq > (maxSeq.get(row.batch) ?? -1)) maxSeq.set(row.batch, seq);
  }

  const widths = new Map<string, number>();
  for (const [batch, largest] of maxSeq) {
    widths.set(batch, seqWidth(largest + 1));
  }

  rows.forEach((row, index) => {
    const lineNumber = index + 2;
    const entry = toEntry(
      quizDataDir,
      row,
      lineNumber,
      errors,
      widths.get(row.batch) ?? 1,
    );
    if (entry === undefined) return;

    const duplicatedAt = seenIds.get(entry.id);
    if (duplicatedAt !== undefined) {
      errors.push(
        `${lineNumber} 行目: ${entry.id} が ${duplicatedAt} 行目と重複しています。`,
      );
      return;
    }
    seenIds.set(entry.id, lineNumber);
    entries.push(entry);
  });

  if (errors.length > 0) {
    throw new Error(`questions.csv に問題があります。\n  - ${errors.join('\n  - ')}`);
  }
  if (entries.length === 0) {
    throw new Error('questions.csv に出題可能な問題がありません。');
  }
  return entries;
}
