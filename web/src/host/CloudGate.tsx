import { useEffect, useState, type FormEvent } from 'react';
import { cloudRequest, requireOk } from '../lib/cloud';
import { App } from './App';

/** ローカル版には従来のトークン画面を、クラウド版には開催入口を表示する。 */
export function CloudGate() {
  const [mode, setMode] = useState<'loading' | 'local' | 'login' | 'host'>('loading');
  const [password, setPassword] = useState('');
  const [hours, setHours] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await fetch('/api/cloud');
        if (info.status === 404) {
          if (!cancelled) setMode('local');
          return;
        }
        await requireOk(info);
        const session = await fetch('/api/session');
        if (!cancelled) setMode(session.ok ? 'host' : 'login');
      } catch {
        if (!cancelled) {
          setError('サーバに接続できません。ページを再読み込みしてください。');
          setMode('login');
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await requireOk(await cloudRequest('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      }));
      const { active } = await response.json() as { active: boolean };
      setPassword('');
      if (!active) {
        if (file === null) throw new Error('新しい大会には問題ZIPを選択してください。');
        if (file.size > 24 * 1024 * 1024) throw new Error('ZIPは24 MiB以下にしてください。');
        const query = hours === '' ? '' : `?hours=${encodeURIComponent(hours)}`;
        await requireOk(await cloudRequest(`/api/tournament${query}`, {
          method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file,
        }));
      }
      setMode('host');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '開始できませんでした。');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'loading') return <main className="cloud-entry"><p>接続しています…</p></main>;
  if (mode === 'local') return <App />;
  if (mode === 'host') return <App cloud onEnded={() => setMode('login')} />;
  return (
    <main className="cloud-entry">
      <h1>早押しクイズ大会</h1>
      <p>主催者が認証して大会を開始します。開催中の場合は、その大会へ復帰します。</p>
      <form onSubmit={event => void start(event)}>
        <label>主催者パスワード
          <input type="password" autoComplete="current-password" required maxLength={1024}
            value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
        </label>
        <label>開催時間（時間）
          <input type="number" min="0.01" max="168" step="0.01" placeholder="未指定なら24時間"
            value={hours} onChange={event => setHours(event.target.value)} disabled={busy} />
        </label>
        <label>問題データ（ZIP、24 MiB以下）
          <input type="file" accept=".zip,application/zip" disabled={busy}
            onChange={event => setFile(event.target.files?.[0] ?? null)} />
        </label>
        <p>ZIPの直下に questions.csv と音声のバッチフォルダを入れてください。開催中の大会への復帰では、時間・ZIPの入力は不要です。</p>
        <button className="control primary" disabled={busy} type="submit">
          {busy ? '確認しています…' : '認証して開始・復帰'}
        </button>
        {error && <p role="alert" className="host-error">{error}</p>}
      </form>
    </main>
  );
}

export function TournamentSettings({ onEnded }: { onEnded: () => void }) {
  const [open, setOpen] = useState(false);
  const [expires, setExpires] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void fetch('/api/session').then(requireOk).then(response => response.json())
      .then((value: { expires_at: number }) => setExpires(value.expires_at))
      .catch(() => setError('開催情報を取得できませんでした。'));
  }, []);
  const end = async () => {
    setBusy(true);
    try {
      await requireOk(await cloudRequest('/api/tournament/end', { method: 'POST' }));
      onEnded();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '終了できませんでした。');
      setBusy(false);
    }
  };
  return <>
    <button className="control" onClick={() => setOpen(true)}>大会設定</button>
    {open && <div className="cloud-overlay"><section role="dialog" aria-modal="true" aria-labelledby="settings-title" className="cloud-dialog">
      <h2 id="settings-title">大会設定</h2>
      <p>終了日時：{expires === null ? '確認中…' : new Date(expires * 1000).toLocaleString()}</p>
      <p>終了すると、すべての参加者の接続が無効になります。</p>
      {error && <p role="alert">{error}</p>}
      {confirm ? <button disabled={busy} className="control wrong" onClick={() => void end()}>{busy ? '終了中…' : '大会を終了する（確定）'}</button>
        : <button className="control wrong" onClick={() => setConfirm(true)}>大会を終了…</button>}
      <button disabled={busy} className="control" onClick={() => { setOpen(false); setConfirm(false); }}>閉じる</button>
    </section></div>}
  </>;
}
