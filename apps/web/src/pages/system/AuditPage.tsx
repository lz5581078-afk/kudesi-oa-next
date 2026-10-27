import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { loadRefOptions } from '../../resources/RecordForm';
import { Pager } from '../finance/common';
import { copyText, useDebounced } from '../flow/flowUi';

interface Item { source: 'system' | 'resource'; id: string; at: string; actorName: string | null; actorId: number | null; action: string; resourceType: string; resourceId: string | null; detail: unknown }
interface Result { total: number; page: number; size: number; items: Item[] }

const fmt = (s: string) => new Date(s).toLocaleString('zh-CN', { hour12: false });

/** 审计日志：系统操作 + 资料变更，只读。可按来源、操作人、关键字筛选，详情可复制。 */
export function AuditPage() {
  const [source, setSource] = useState('');
  const [actorId, setActorId] = useState('');
  const [keyword, setKeyword] = useState('');
  const kw = useDebounced(keyword.trim(), 300);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Result | null>(null);
  const [users, setUsers] = useState<Array<{ value: number; label: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState('');

  useEffect(() => { loadRefOptions('user').then(setUsers).catch(() => undefined); }, []);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ page: String(page) });
      if (source) q.set('source', source);
      if (actorId) q.set('actorId', actorId);
      if (kw) q.set('keyword', kw);
      setData(await api<Result>(`/audit?${q}`));
      setError('');
    } catch (e) { setError(e instanceof ApiError ? e.message : '加载失败'); }
    setLoading(false);
  }, [page, source, actorId, kw]);
  useEffect(() => { void load(); }, [load]);

  const filtered = Boolean(source || actorId || kw);
  const clear = () => { setSource(''); setActorId(''); setKeyword(''); setPage(1); };
  async function copyDetail(r: Item) {
    setCopied((await copyText(JSON.stringify(r.detail, null, 2))) ? '详情已复制' : '复制失败，请手动选中复制');
  }
  return (
    <section className="page">
      <div className="page-head"><h1>审计日志</h1><button type="button" className="secondary-button" disabled={loading} onClick={() => void load()}>刷新</button></div>
      <div className="toolbar">
        <select value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} aria-label="来源">
          <option value="">全部来源</option><option value="system">系统操作</option><option value="resource">资料变更</option>
        </select>
        <select value={actorId} onChange={(e) => { setActorId(e.target.value); setPage(1); }} aria-label="操作人">
          <option value="">全部操作人</option>{users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
        </select>
        <input type="search" className="search-input" aria-label="搜索" placeholder="搜索动作 / 类型 / 编号" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
        {filtered && <button type="button" className="secondary-button" onClick={clear}>清除筛选</button>}
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {copied && <div role="status" className="notice ok-notice toast-line"><span>{copied}</span><button type="button" aria-label="关闭提示" onClick={() => setCopied('')}>✕</button></div>}
      <div className="table-scroll"><table className="data-table stack-mobile">
        <thead><tr><th>时间</th><th>来源</th><th>操作人</th><th>动作</th><th>对象</th><th /></tr></thead>
        <tbody>
          {data?.items.map((r) => {
            const k = `${r.source}-${r.id}`;
            return (
              <Fragment key={k}>
                <tr>
                  <td data-label="时间">{fmt(r.at)}</td><td data-label="来源">{r.source === 'system' ? '系统操作' : '资料变更'}</td><td data-label="操作人">{r.actorName ?? '系统'}</td>
                  <td data-label="动作">{r.action}</td><td data-label="对象">{r.resourceType}{r.resourceId ? ` #${r.resourceId}` : ''}</td>
                  <td><button type="button" className="link-button" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>{open === k ? '收起' : '详情'}</button></td>
                </tr>
                {open === k && (
                  <tr><td colSpan={6}>
                    <pre className="json-box">{JSON.stringify(r.detail, null, 2)}</pre>
                    <button type="button" className="secondary-button small" onClick={() => void copyDetail(r)}>复制详情</button>
                  </td></tr>
                )}
              </Fragment>
            );
          })}
          {loading && !data && <tr><td colSpan={6} className="empty-state muted">正在加载…</td></tr>}
          {data && data.items.length === 0 && (
            <tr><td colSpan={6} className="empty-state muted"><strong>没有记录</strong>{filtered && <button type="button" className="secondary-button" onClick={clear}>清除筛选，查看全部</button>}</td></tr>
          )}
        </tbody>
      </table></div>
      {data && <Pager page={page} pageSize={data.size} total={data.total} onPage={setPage} />}
    </section>
  );
}
