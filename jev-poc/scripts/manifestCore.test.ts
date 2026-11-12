import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEntries, findAudioPaths, seqWidth } from './manifestCore';

const TMP = join(process.cwd(), '.tmp-manifest-test');

function writeAudio(batch: string, seq: number, width: number, text: string) {
  const dir = join(TMP, batch);
  mkdirSync(dir, { recursive: true });
  const base = `${String(seq).padStart(width, '0')}-${batch}`;
  writeFileSync(join(dir, `${base}.wav`), 'fake');
  writeFileSync(join(dir, `${base}.txt`), text);
  writeFileSync(join(dir, `${base}.lab`), 'pau 0 100\n');
}

function writePartial(batch: string, seq: number, width: number, exts: string[]) {
  const dir = join(TMP, batch);
  mkdirSync(dir, { recursive: true });
  const base = `${String(seq).padStart(width, '0')}-${batch}`;
  for (const ext of exts) {
    writeFileSync(join(dir, `${base}${ext}`), ext === '.txt' ? 'text' : 'x');
  }
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('buildEntries', () => {
  it('3 点が揃った行は音声あり', () => {
    writeAudio('20260101', 0, 1, '問題文');
    const entries = buildEntries(
      TMP,
      'batch,seq,text,answer,alt_answers\n20260101,0,問題文,答え,\n',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hasAudio).toBe(true);
    expect(entries[0]!.wav).toContain('.wav');
  });

  it('どの桁にもファイルが無い行は音声なし', () => {
    const entries = buildEntries(
      TMP,
      'batch,seq,text,answer,alt_answers\ncsvonly,0,音声なしの問題,答え,\n',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hasAudio).toBe(false);
    expect(entries[0]!.wav).toBeNull();
  });

  it('想定桁に一部だけある行はエラー（他桁に 3 点そろっていても）', () => {
    // 想定桁は max seq+1 = 1（seq=0 のみ）→ width 1
    writePartial('20260101', 0, 1, ['.wav', '.txt']); // 一部
    writeAudio('20260101', 0, 2, '問題文'); // 他桁に 3 点
    expect(() =>
      buildEntries(
        TMP,
        'batch,seq,text,answer,alt_answers\n20260101,0,問題文,答え,\n',
      ),
    ).toThrow(/揃っていません/);
  });

  it('想定桁が空で別の桁に 3 点そろっている行は音声あり', () => {
    // CSV に seq=10 を足すと width=2。seq=0 の実ファイルは 1 桁のまま
    writeAudio('20260101', 0, 1, '問題文A');
    const entries = buildEntries(
      TMP,
      'batch,seq,text,answer,alt_answers\n' +
        '20260101,0,問題文A,答えA,\n' +
        '20260101,10,音声なしB,答えB,\n',
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.hasAudio).toBe(true);
    expect(entries[1]!.hasAudio).toBe(false);
  });

  it('.txt と CSV の text が違う行はエラー', () => {
    writeAudio('20260101', 0, 1, 'TXTの文');
    expect(() =>
      buildEntries(
        TMP,
        'batch,seq,text,answer,alt_answers\n20260101,0,CSVの文,答え,\n',
      ),
    ).toThrow(/一致しません/);
  });
});

describe('findAudioPaths / seqWidth', () => {
  it('seqWidth は出力数の桁', () => {
    expect(seqWidth(9)).toBe(1);
    expect(seqWidth(10)).toBe(2);
  });

  it('想定桁が空で一部だけの桁しか無ければ partial を返す', () => {
    writePartial('b', 0, 1, ['.wav']);
    const result = findAudioPaths(TMP, 'b', 0, 2);
    expect(Object.keys(result.found).length).toBe(1);
    expect(result.missing.length).toBeGreaterThan(0);
  });
});
