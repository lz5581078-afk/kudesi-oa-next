import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface Change { source: string; label: string; before: unknown; after: unknown }
interface Row { id: number; verifiedAt: string; verifiedBy: string; signature: string; first: boolean; changes: Change[] }
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

/** 基础编码的验证历史：每次验证通过一条，二次验证列出和上次验证相比改了什么 */
export function VerificationHistoryPanel({ id }: { id: number }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ rows: Row[] }>(`/finance/base-codes/${id}/verification-events`).then((r) => alive && setRows(r.rows)).catch(() => alive && setRows([]));
    return () => { alive = false; };
  }, [id]);
  if (rows === null) return <p className="muted">加载中…</p>;
  if (!rows.length) return <p className="muted">还没有验证记录</p>;
  return (
    <ul className="plain-list">
      {rows.map((r) => (
        <li key={r.id}>
          <div className="between"><strong>{new Date(r.verifiedAt).toLocaleString('zh-CN')}</strong><span className="muted">{r.verifiedBy} · {r.first ? '首次验证' : '二次验证'} · 指纹 {r.signature}</span></div>
          {!r.first && (r.changes.length === 0
            ? <p className="muted">和上次验证相比没有可列出的资料变化。</p>
            : <div className="table-scroll"><table className="data-table">
              <thead><tr><th>来源</th><th>项目</th><th>上次验证</th><th>这次</th></tr></thead>
              <tbody>{r.changes.map((c, i) => <tr key={i}><td>{c.source}</td><td>{c.label}</td><td>{show(c.before)}</td><td>{show(c.after)}</td></tr>)}</tbody>
            </table></div>)}
        </li>
      ))}
    </ul>
  );
}
