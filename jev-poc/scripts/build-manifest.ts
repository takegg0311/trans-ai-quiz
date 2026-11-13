/**
 * quiz_data/questions.csv を読み、jev-poc 用の manifest.jev-poc.json を生成する。
 *
 * 凍結 poc/ の manifest.json とは出力先を分ける。音声なし行の扱いで
 * 片方の manifest を壊さないため。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEntries } from './manifestCore';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const quizDataDir = join(repoRoot, 'quiz_data');
const csvPath = join(quizDataDir, 'questions.csv');
const manifestPath = join(quizDataDir, 'manifest.jev-poc.json');

try {
  let source: string;
  try {
    source = readFileSync(csvPath, 'utf8');
  } catch {
    throw new Error(
      `${csvPath} を読み取れませんでした。` +
        'batch,seq,text,answer,alt_answers の 5 列を持つ CSV を配置してください。',
    );
  }

  const entries = buildEntries(quizDataDir, source);
  writeFileSync(manifestPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  console.log(`[manifest] ${entries.length} 問を ${manifestPath} に書き出しました`);
  for (const entry of entries) {
    const tag = entry.hasAudio ? '' : ' (音声なし)';
    console.log(`  - ${entry.id}: ${entry.answers.join(' / ')}${tag}`);
  }
} catch (error) {
  console.error(`[manifest] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
