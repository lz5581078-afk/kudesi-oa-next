import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, GitBranch } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Pager } from '../finance/common';
import { flowApi, fmtTime, type RunList, type TodoList } from '../flow/flowApi';
import { dueHint, useDebounced } from '../flow/flowUi';

type Tab = 'todo' | 'mine' | 'done';
const TABS: Array<[Tab, string]> = [['todo', '待我处理'], ['mine', '我的申请'], ['done', '已办结']];
const RUN_STATUS: Record<string, string> = { running: '进行中', completed: '已完成', cancelled: '已撤销', rejected: '已驳回' };

/** 流程与待办：待我处理 / 我的申请 / 已办结，带搜索和分页；点一行去对应页面办理。 */
export function FlowSection({ refreshKey, onCounts, isCompanyAdmin = false }: { refreshKey: number; isCompanyAdmin?: boolean; onCounts: (c: { todo: number | null; overdue: number | null; mine: number | null }) => void }) {
  const [tab, setTab] = useState<Tab>('todo');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const keyword = useDebounced(search.trim(), 250);
  const [todos, setTodos] = useState<TodoList | null>(null);
  const [runs, setRuns] = useState<RunList | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const load = useCallback(() => {
    setLoading(true);
    const p = tab === 'mine'
      ? flowApi.runs({ view: 'started', keyword: keyword || undefined, page, pageSize: 8 }).then((r) => { setRuns(r); setTodos(null); })
      : flowApi.todos({ tab: tab === 'todo' ? 'pending' : 'done', keyword: keyword || undefined, page }).then((r) => { setTodos(r); setRuns(null); onCounts({ todo: r.counts.pending, overdue: r.counts.overdue, mine: null }); });
    p.then(() => setError('')).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')).finally(() => setLoading(false));
  }, [tab, page, keyword, onCounts]);
  useEffect(load, [load, refreshKey]);
  // “我的申请”总数：只在切到该页签时才有，顶部卡片没取到就显示“—”
  useEffect(() => { if (runs && !keyword) onCounts({ todo: null, overdue: null, mine: runs.total }); }, [runs, keyword, onCounts]);
  const now = Date.now();
  const total = tab === 'mine' ? runs?.total ?? 0 : todos?.total ?? 0;
  const empty = !loading && !error && total === 0;
  return (
    <section className="card ws-section" aria-label="流程与待办">
      <div className="ws-head"><h2><GitBranch size={17} /> 流程与待办</h2><span className="muted">本人申请与分配给我的节点</span></div>
      <div className="ws-flow-tools">
        <div className="tabs" role="tablist" aria-label="流程分类">
          {TABS.map(([k, label]) => <button key={k} role="tab" type="button" aria-selected={tab === k} className={tab === k ? 'tab active' : 'tab'} onClick={() => { setTab(k); setPage(1); setSearch(''); }}>{label}</button>)}
        </div>
        <input type="search" aria-label="搜索流程与待办" placeholder="搜索申请标题" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </div>
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      {!empty && total > 0 && <div className="table-scroll" aria-busy={loading}>
        <table className="data-table stack-mobile desk-flow-table">
          <thead><tr><th>申请事项</th><th>状态</th><th>当前环节 / 处理人</th><th>操作</th></tr></thead>
          <tbody>
            {tab !== 'mine' && todos?.rows.map(r => {
              const path = r.runId ? `/workbench/todos?run=${r.runId}` : '/workbench/todos';
              const label = tab === 'done' ? '已办结' : r.overdue ? '已超时' : r.enteredVia === 'return' ? '被退回' : '待处理';
              return <tr key={r.id}>
                <td className="cell-title"><button type="button" className="link-button" onClick={() => navigate(path)}>{r.runTitle || r.title}</button><small>{r.templateLabel} · {r.requesterName}</small></td>
                <td data-label="状态"><span className={`pill ${r.overdue && tab === 'todo' ? 'bad' : ''}`}>{label}</span></td>
                <td data-label="当前环节">{r.stepName || '—'}{tab === 'todo' && r.dueAt && <small>{dueHint(r.dueAt, now).text}</small>}{tab === 'done' && r.finishedAt && <small>{fmtTime(r.finishedAt)} 办结</small>}</td>
                <td data-label="操作"><Link className="desk-flow-link" to={path}>{tab === 'todo' ? '去处理' : '查看记录'} <ArrowRight size={14} /></Link></td>
              </tr>;
            })}
            {tab === 'mine' && runs?.rows.map(r => {
              const path = `/workbench/started?run=${r.id}`;
              return <tr key={r.id}>
                <td className="cell-title"><button type="button" className="link-button" onClick={() => navigate(path)}>{r.title}</button><small>{r.templateLabel}</small></td>
                <td data-label="状态"><span className={`pill ${r.overdue ? 'bad' : r.status === 'completed' ? 'ok' : ''}`}>{r.overdue ? '已超时' : RUN_STATUS[r.status] ?? r.status}</span></td>
                <td data-label="当前环节">{r.stepName ?? '已归档'}{r.handlers.length > 0 && <small>{r.handlers.join('、')}</small>}</td>
                <td data-label="操作"><Link className="desk-flow-link" to={path}>查看申请 <ArrowRight size={14} /></Link></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>}
      {loading && total === 0 && !error && <p className="muted ws-pad" role="status">正在读取流程…</p>}
      {empty && (
        <div className="ws-empty muted">
          <strong>{keyword ? `没有匹配“${keyword}”的记录` : tab === 'todo' ? '暂无待我处理的事项，歇一会儿' : tab === 'mine' ? '你还没有发起过申请' : '还没有办结的记录'}</strong>
          {keyword ? <button type="button" className="secondary-button" onClick={() => setSearch('')}>清除搜索</button> : tab === 'mine' && <Link to={isCompanyAdmin ? "/flow/apply" : "/workbench/desk"}>{isCompanyAdmin ? "去申请中心发起" : "去岗位工作台发起"}</Link>}
        </div>
      )}
      {total > 8 && <Pager page={page} total={total} pageSize={8} onPage={setPage} />}
    </section>
  );
}
