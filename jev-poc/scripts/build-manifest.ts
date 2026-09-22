/**
 * quiz_data/questions.csv を読み、問題一覧 manifest.json を生成する。
 *
 * PoC はバックエンドを持たないため、ブラウザからディレクトリ一覧や CSV を
 * 解決できない。代わりにビルド前へこのスクリプトを挟み、CSV と VOICEPEAK の
 * 出力ファイルを突き合わせた結果を manifest.json として書き出す。
 *
 * 音声ファイルは VOICEPEAK が出力したまま `{batch}/{seq}-{batch}.{ext}` に置く。
 * VOICEPEAK は連番を 0 起点でしか振れず接頭語も付けられないため、
 * バッチ（日付）フォルダと連番の組で一意性を与えている。
 *
 * quiz_data はリポジトリルートに置き、オンライン版と共有している。
 * PoC からは poc/public/quiz_data のシンボリックリンク経由で配信されるが、
 * このスクリプトは実体を直接読み書きする。
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const quizDataDir = join(repoRoot, 'quiz_data');
const csvPath = join(quizDataDir, 'questions.csv');
const manifestPath = join(quizDataDir, 'manifest.json');

/** 1 問につきこの 3 つが揃っている必要がある */
const REQUIRED_EXTENSIONS = ['.wav', '.txt', '.lab'] as const;

/** alt_answers 列の区切り文字 */
const ALT_ANSWER_SEPARATOR = '|';

const CSV_COLUMNS = ['batch', 'seq', 'text', 'answer', 'alt_answers'] as const;
type ColumnName = (typeof CSV_COLUMNS)[number];

type Row = Record<ColumnName, string>;

type Entry = {
  /** `{batch}/{seq}` 形式の問題 ID */
  id: string;
  batch: string;
  seq: number;
  /** 音声ファイルの参照パス（quiz_data からの相対） */
  wav: string;
  txt: string;
  lab: string;
  text: string;
  /** 正解と別解。先頭が主たる正解 */
  answers: string[];
};

/**
 * 1 問分のファイルの、quiz_data からの相対パスを組み立てる。
 *
 * VOICEPEAK は連番だけの出力ができず接尾語が必須のため、接尾語にバッチ名
 * （日付）を指定する運用とし、`{batch}/{seq}-{batch}.{ext}` を期待する。
 * 接尾語がフォルダ名と一致することで、別バッチのファイルを取り違えて
 * 置いた場合にファイルが見つからず検出できる。
 *
 * 連番は width 桁までゼロ埋めする（`00-20260821.wav` など）。桁数は
 * バッチ内の出力数で決まるため、呼び出し側が seqWidth で求めて渡す。
 */
function questionFilePath(batch: string, seq: number, ext: string, width = 1): string {
  return `${batch}/${String(seq).padStart(width, '0')}-${batch}${ext}`;
}

/**
 * 出力数から、連番のゼロ埋め桁数を求める。
 *
 * VOICEPEAK は同じ接尾語で出力したファイル数に応じて連番をゼロ埋めする。
 * 10 個以上なら 2 桁、100 個以上なら 3 桁。境界は連番の値ではなく出力数で
 * 決まるため、9 個（0〜8）は 1 桁、10 個（00〜09）は 2 桁になる。
 */
function seqWidth(count: number): number {
  return String(Math.max(count, 1)).length;
}

/**
 * RFC 4180 相当の CSV パーサ。
 * 問題文に `,` が含まれるためクォートの解釈が要る。
 */
function parseCsv(source: string): string[][] {
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
        // 連続する "" はエスケープされた 1 文字の "
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

  // 最終行が改行で終わっていない場合を拾う
  if (field !== '' || hasField || row.length > 0) endRow();

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** ヘッダ行を検証し、データ行を列名つきの Row に変換する */
function toRows(cells: string[][]): Row[] {
  const [header, ...dataRows] = cells;
  if (header === undefined) {
    throw new Error('questions.csv が空です。');
  }

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

/** 正解と別解をまとめる。空要素は落とす */
function toAnswers(row: Row): string[] {
  const alternatives = row.alt_answers
    .split(ALT_ANSWER_SEPARATOR)
    .map((value) => value.trim())
    .filter((value) => value !== '');

  return [row.answer, ...alternatives];
}

/**
 * 1 行を検証して Entry にする。
 * 問題があれば errors へ理由を積み、undefined を返す。
 */
function toEntry(
  row: Row,
  lineNumber: number,
  errors: string[],
  width: number,
): Entry | undefined {
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

  // 1 問 1 ブロックが前提。改行があると seq が複数消費され対応が崩れる
  if (row.text.includes('\n')) {
    errors.push(`${label}: text に改行を含められません（1 問 1 ブロック）。`);
  }

  if (errors.length > before) return undefined;

  const id = `${row.batch}/${seq}`;
  const paths = {} as Record<(typeof REQUIRED_EXTENSIONS)[number], string>;

  for (const ext of REQUIRED_EXTENSIONS) {
    const relativePath = questionFilePath(row.batch, seq, ext, width);
    if (!existsSync(join(quizDataDir, relativePath))) {
      errors.push(`${label} (${id}): ${relativePath} が見つかりません。`);
      continue;
    }
    paths[ext] = relativePath;
  }

  if (errors.length > before) return undefined;

  // CSV の text と VOICEPEAK が出力した txt を突き合わせる。
  // ズレたまま出題されるとクイズを遊ぶまで気づけないため、ここで止める。
  const txtContent = readFileSync(join(quizDataDir, paths['.txt']), 'utf8').trim();
  if (txtContent !== row.text) {
    errors.push(
      `${label} (${id}): text が ${paths['.txt']} と一致しません。\n` +
        `    CSV: ${row.text}\n` +
        `    TXT: ${txtContent}`,
    );
    return undefined;
  }

  return {
    id,
    batch: row.batch,
    seq,
    wav: paths['.wav'],
    txt: paths['.txt'],
    lab: paths['.lab'],
    text: row.text,
    answers: toAnswers(row),
  };
}

function buildManifest(): Entry[] {
  let source: string;
  try {
    source = readFileSync(csvPath, 'utf8');
  } catch {
    throw new Error(
      `${csvPath} を読み取れませんでした。` +
        'batch,seq,text,answer,alt_answers の 5 列を持つ CSV を配置してください。',
    );
  }

  const rows = toRows(parseCsv(source));
  const errors: string[] = [];
  const entries: Entry[] = [];
  const seenIds = new Map<string, number>();

  // ファイル名のゼロ埋め桁数はバッチ内の出力数で決まるため、行ごとの検証に入る前に
  // バッチごとの連番の最大値を集める。不正な値はここでは弾かず toEntry が報告する。
  const maxSeq = new Map<string, number>();
  for (const row of rows) {
    const seq = Number(row.seq);
    if (row.seq === '' || !Number.isInteger(seq) || seq < 0) continue;
    if (seq > (maxSeq.get(row.batch) ?? -1)) maxSeq.set(row.batch, seq);
  }

  // 連番は 0 起点なので、出力数は最大値 + 1。
  // CSV の行数を使わないのは、行を削っても実ファイル名の桁数は変わらないため。
  const widths = new Map<string, number>();
  for (const [batch, largest] of maxSeq) widths.set(batch, seqWidth(largest + 1));

  rows.forEach((row, index) => {
    // ヘッダ行があるため、CSV 上の行番号は +2
    const lineNumber = index + 2;
    const entry = toEntry(row, lineNumber, errors, widths.get(row.batch) ?? 1);
    if (entry === undefined) return;

    const duplicatedAt = seenIds.get(entry.id);
    if (duplicatedAt !== undefined) {
      errors.push(`${lineNumber} 行目: ${entry.id} が ${duplicatedAt} 行目と重複しています。`);
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

try {
  const entries = buildManifest();
  writeFileSync(manifestPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  console.log(`[manifest] ${entries.length} 問を ${manifestPath} に書き出しました`);
  for (const entry of entries) console.log(`  - ${entry.id}: ${entry.answers.join(' / ')}`);
} catch (error) {
  console.error(`[manifest] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
