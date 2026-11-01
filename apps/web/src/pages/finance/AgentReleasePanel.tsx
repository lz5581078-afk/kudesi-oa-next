import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { fmtTime } from '../flow/flowApi';
import { sessionApi, type AgentRelease, type SessionClient } from './sessionApi';

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** 授权电脑页里的“助手安装包”：上传 npm run pack 生成的 .kapkg，服务器核对 SHA-256 与包内文件；助手只下载被安排升级的版本。 */
export function AgentReleasePanel({ client = sessionApi, onChange }: { client?: SessionClient; onChange?: () => void }) {
  const [rows, setRows] = useState<AgentRelease[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [sha, setSha] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(() => { client.releases().then(setRows).catch(() => undefined); }, [client]);
  useEffect(() => { load(); }, [load]);
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : '操作失败');
  const upload = () => {
    const f = file.current?.files?.[0];
    if (!f) { setError('请先选择升级包文件（.kapkg）'); return; }
    setBusy(true); setError(''); setMsg('');
    client.publishRelease(f, { sha256: sha.trim() || undefined, notes: notes.trim() || undefined })
      .then((r) => { setMsg(`已发布 v${r.version}（SHA-256 ${r.sha256.slice(0, 16)}…），现在可以点“全部升级”`); setSha(''); setNotes(''); if (file.current) file.current.value = ''; load(); onChange?.(); })
      .catch(fail).finally(() => setBusy(false));
  };
  return (
    <details className="panel-block">
      <summary><strong>助手安装包</strong>{rows.find((r) => r.isLatest) ? <span className="muted"> 当前最新 v{rows.find((r) => r.isLatest)!.version}</span> : <span className="muted"> 还没有上传</span>}</summary>
      <p className="muted">在开发电脑运行 npm run pack -w @kudesi/agent，把 release/update 里的 .kapkg 文件传到这里。版本号取自升级包本身，必须比已发布的最高版本高；SHA-256 可选，填了会和上传的文件核对。</p>
      <div className="toolbar">
        <input ref={file} type="file" accept=".kapkg" aria-label="选择升级包" />
        <input value={sha} onChange={(e) => setSha(e.target.value)} placeholder="SHA-256（可选）" aria-label="SHA-256" style={{ width: 260 }} />
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="更新说明（可选）" aria-label="更新说明" maxLength={300} />
        <button type="button" className="primary-button" disabled={busy} onClick={upload}>{busy ? '上传中…' : '上传并发布'}</button>
      </div>
      {msg && <div role="status" className="notice ok">{msg}</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
      {rows.length > 0 && <div className="table-scroll"><table className="data-table">
        <thead><tr><th>版本</th><th>大小</th><th>SHA-256</th><th>说明</th><th>发布</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td>v{r.version}{r.isLatest && <span className="pill ok"> 最新</span>}{r.withdrawnAt && <span className="pill bad"> 已撤回</span>}</td><td>{kb(r.size)}</td><td className="mono" title={r.sha256}>{r.sha256.slice(0, 16)}…</td><td>{r.notes}</td><td>{fmtTime(r.createdAt)} {r.createdByName}</td>
            <td>{!r.withdrawnAt && <button type="button" className="link-button" onClick={() => { if (window.confirm(`撤回 v${r.version}？已安排升级到该版本但还没完成的电脑会标记为失败。`)) client.withdrawRelease(r.id).then(() => { load(); onChange?.(); }).catch(fail); }}>撤回</button>}</td></tr>
        ))}</tbody>
      </table></div>}
    </details>
  );
}
