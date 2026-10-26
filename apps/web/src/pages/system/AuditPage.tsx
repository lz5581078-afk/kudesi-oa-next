import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';

interface Item { source: 'system' | 'resource'; id: string; at: string; actorName: string | null; actorId: number | null; action: string; resourceType: string; resourceId: string | null; detail: unknown }
interface Result { total: number; page: number; size: number; items: Item[] }

const fmt = (s: string) => new Date(s).toLocaleString('zh-CN', { hour12: false });

/** 审计日志：系统操作 + 资料变更，只读。 */
export function AuditPage() {
  const [source, setSource] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ page: String(page) });
      if (source) q.set('source', source);
      if (keyword.trim()) q.set('keyword', keyword.trim());
      setData(await api<Result>(`/audit?${q}`));
      setError('');
    } catch (e) { setError(e instanceof ApiError ? e.message : '加载失败'); }
  }, [page, source, keyword]);
  useEffect(() => { void load(); }, [load]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  return (
    <section className="page">
      <h1>审计日志</h1>
      <div className="toolbar">
        <select value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} aria-label="来源">
          <option value="">全部来源</option><option value="system">系统操作</option><option value="resource">资料变更</option>
        </select>
        <input placeholder="搜索动作 / 类型 / 编号" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      <table className="data-table">
        <thead><tr><th>时间</th><th>来源</th><th>操作人</th><th>动作</th><th>对象</th><th /></tr></thead>
        <tbody>
          {data?.items.map((r) => {
            const k = `${r.source}-${r.id}`;
            return (
              <>
                <tr key={k}>
                  <td>{fmt(r.at)}</td><td>{r.source === 'system' ? '系统操作' : '资料变更'}</td><td>{r.actorName ?? '系统'}</td>
                  <td>{r.action}</td><td>{r.resourceType}{r.resourceId ? ` #${r.resourceId}` : ''}</td>
                  <td><button type="button" className="link-button" onClick={() => setOpen(open === k ? null : k)}>{open === k ? '收起' : '详情'}</button></td>
                </tr>
                {open === k && <tr key={`${k}-d`}><td colSpan={6}><pre className="json-box">{JSON.stringify(r.detail, null, 2)}</pre></td></tr>}
              </>
            );
          })}
          {data && data.items.length === 0 && <tr><td colSpan={6} className="muted">没有记录</td></tr>}
        </tbody>
      </table>
      <div className="pager">
        <button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span>{page} / {pages}（共 {data?.total ?? 0} 条）</span>
        <button type="button" className="secondary-button" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
    </section>
  );
}
