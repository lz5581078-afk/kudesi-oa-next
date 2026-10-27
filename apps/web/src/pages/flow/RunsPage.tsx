import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RUN_STATUS_LABEL } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { Pager } from '../finance/common';
import { RunDetail } from './RunDetail';
import { RUN_TONE, flowApi, fmtTime, type RunList, type TemplateInfo } from './flowApi';
import { dueHint, dwell, useDebounced } from './flowUi';
import { flattenDepartments, orgApi } from '../org/orgApi';

type View = 'started' | 'cc' | 'all';
const TITLE: Record<View, string> = { started: '我发起的', cc: '抄送我的', all: '流程总览' };
const EMPTY_HINT: Record<View, string> = {
  started: '你还没有发起过流程。',
  cc: '别人把流程抄送给你时，会出现在这里。',
  all: '公司里还没有流程。',
};

/** 我发起的 / 抄送我的 / 流程总览：同一张列表，只是范围不同（总览要流程总览权限，服务端把关）。 */
export function RunsPage({ view }: { view: View }) {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [keyword, setKeyword] = useState('');
  const kw = useDebounced(keyword.trim(), 300);
  const [overdue, setOverdue] = useState(false);
  const [departmentId, setDepartmentId] = useState('');
  const [handler, setHandler] = useState('');
  const handlerKw = useDebounced(handler.trim(), 300);
  const [returned, setReturned] = useState(false);
  const [depts, setDepts] = useState<Array<{ id: number; name: string; depth: number }>>([]);
  const [page, setPage] = useState(1);
  const [list, setList] = useState<RunList | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [stats, setStats] = useState<{ running: number; overdue: number; returned: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState('');
  const open = Number(params.get('run')) || null;

  // 视图切换时清空筛选，避免把“流程总览”的筛选带到“我发起的”
  useEffect(() => { setStatus(''); setTemplateKey(''); setKeyword(''); setOverdue(false); setDepartmentId(''); setHandler(''); setReturned(false); setPage(1); }, [view]);

  const load = useCallback(() => {
    setLoading(true);
    flowApi.runs({ view, status, templateKey, keyword: kw, overdue, returned, departmentId: departmentId ? Number(departmentId) : undefined, handler: handlerKw, page })
      .then((r) => { setList(r); setError(''); setUpdatedAt(Date.now()); })
      .catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'))
      .finally(() => setLoading(false));
    if (view === 'all') {
      Promise.all([flowApi.runs({ view, status: 'running', pageSize: 1 }), flowApi.runs({ view, overdue: true, pageSize: 1 }), flowApi.runs({ view, returned: true, pageSize: 1 })])
        .then(([a, b, c]) => setStats({ running: a.total, overdue: b.total, returned: c.total })).catch(() => undefined);
    }
  }, [view, status, templateKey, kw, overdue, returned, departmentId, handlerKw, page]);
  useEffect(load, [load]);
  useEffect(() => { flowApi.templates().then(setTemplates).catch(() => undefined); }, []);
  useEffect(() => { if (view === 'all') orgApi.departments().then((d) => setDepts(flattenDepartments(d))).catch(() => undefined); }, [view]);
  // 流程总览是看板：页面可见时每分钟自动刷新一次
  useEffect(() => {
    if (view !== 'all') return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60_000);
    return () => clearInterval(t);
  }, [view, load]);

  const filtered = Boolean(status || templateKey || kw || overdue || returned || departmentId || handlerKw);
  const clear = () => { setStatus(''); setTemplateKey(''); setKeyword(''); setOverdue(false); setReturned(false); setDepartmentId(''); setHandler(''); setPage(1); };
  const now = Date.now();

  return (
    <div>
      <div className="page-head">
        <h1>{TITLE[view]}</h1>
        <div className="row-actions">
          {updatedAt && <span className="muted">{loading ? '更新中…' : `更新于 ${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}${view === 'all' ? ' · 每分钟自动刷新' : ''}`}</span>}
          <button type="button" className="secondary-button" disabled={loading} onClick={load}>刷新</button>
        </div>
      </div>
      {view === 'all' && stats && (
        <div className="stat-tiles" aria-label="进行中的流程统计">
          <button type="button" className={`stat-tile${status === 'running' && !overdue ? ' on' : ''}`} onClick={() => { setStatus('running'); setOverdue(false); setReturned(false); setPage(1); }}><span>进行中</span><strong>{stats.running}</strong></button>
          <button type="button" className={`stat-tile bad${overdue ? ' on' : ''}`} onClick={() => { setStatus(''); setOverdue(true); setReturned(false); setPage(1); }}><span>已超时</span><strong>{stats.overdue}</strong></button>
          <button type="button" className={`stat-tile warn${returned ? ' on' : ''}`} onClick={() => { setStatus(''); setOverdue(false); setReturned(true); setPage(1); }}><span>退回待补充</span><strong>{stats.returned}</strong></button>
        </div>
      )}
      <div className="toolbar">
        <input type="search" className="search-input" aria-label="搜索标题" placeholder="搜索标题" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
        <select aria-label="流程类型" value={templateKey} onChange={(e) => { setTemplateKey(e.target.value); setPage(1); }}>
          <option value="">全部类型</option>
          {templates.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select aria-label="流程状态" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">全部状态</option>
          {Object.entries(RUN_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {view === 'all' && (
          <>
            <select aria-label="发起部门" value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setPage(1); }}>
              <option value="">全部发起部门</option>
              {depts.map((d) => <option key={d.id} value={d.id}>{'　'.repeat(d.depth)}{d.name}</option>)}
            </select>
            <input type="search" className="search-input" aria-label="当前办理人" placeholder="当前办理人" value={handler} onChange={(e) => { setHandler(e.target.value); setPage(1); }} />
          </>
        )}
        <label className="check-line"><input type="checkbox" checked={overdue} onChange={(e) => { setOverdue(e.target.checked); setPage(1); }} />只看已逾期</label>
        {filtered && <button type="button" className="secondary-button" onClick={clear}>清除筛选</button>}
      </div>
      {filtered && list && <div className="status-line" role="status">已筛选，找到 {list.total} 条</div>}
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      <div className="table-scroll"><table className="data-table stack-mobile">
        <thead><tr><th>标题</th><th>类型</th><th>发起人</th><th>状态</th><th>当前步骤</th><th>当前办理人</th><th>截止</th><th>发起时间</th><th /></tr></thead>
        <tbody>
          {loading && !list && <tr><td colSpan={9} className="empty-state muted">正在加载…</td></tr>}
          {list?.rows.length === 0 && (
            <tr><td colSpan={9} className="empty-state muted">
              <strong>{filtered ? '没有匹配的流程' : '没有流程'}</strong>
              <span>{filtered ? '换个条件试试。' : EMPTY_HINT[view]}</span>
              {filtered && <button type="button" className="secondary-button" onClick={clear}>清除筛选，查看全部</button>}
              {!filtered && view === 'started' && <Link to="/flow/apply">去申请中心发起</Link>}
            </td></tr>
          )}
          {list?.rows.map((r) => {
            const hint = dueHint(r.dueAt, now);
            const running = r.status === 'running';
            return (
              <tr key={r.id} className={r.overdue && running ? 'late' : undefined}>
                <td className="cell-title"><button type="button" className="link-button" onClick={() => setParams({ run: String(r.id) })}>{r.title}</button></td>
                <td data-label="类型">{r.templateLabel}</td>
                <td data-label="发起人">{r.requesterName}</td>
                <td data-label="状态"><span className={`pill ${RUN_TONE[r.status] ?? ''}`}>{RUN_STATUS_LABEL[r.status as keyof typeof RUN_STATUS_LABEL]}</span></td>
                <td data-label="当前步骤">{r.stepName ?? ''}{running && r.stepEnteredAt && dwell(r.stepEnteredAt, now) && <span className="sub-line">已停留 {dwell(r.stepEnteredAt, now)}</span>}</td>
                <td data-label="当前办理人">{r.handlers.join('、')}</td>
                <td data-label="截止">{r.dueAt && running ? <span>{fmtTime(r.dueAt)}<span className={`sub-line${hint.late ? ' late-text' : ''}`}>{hint.text}</span></span> : ''}</td>
                <td data-label="发起时间">{fmtTime(r.createdAt)}</td>
                <td><button type="button" className="secondary-button small" onClick={() => setParams({ run: String(r.id) })}>查看</button></td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      {list && <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={setPage} />}
      {open && <RunDetail id={open} onClose={() => setParams({})} onChanged={load} />}
    </div>
  );
}
