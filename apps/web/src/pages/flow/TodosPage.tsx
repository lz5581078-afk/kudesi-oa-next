import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Pager } from '../finance/common';
import { RunDetail } from './RunDetail';
import { DelayDialog, SubmitTaskDialog } from './TaskDialogs';
import { flowApi, fmtTime, type TodoList, type TodoRow } from './flowApi';
import { dueHint, remember, useDebounced } from './flowUi';

type Tab = 'pending' | 'overdue' | 'returned' | 'done';
const TABS: Array<[Tab, string]> = [['pending', '待办理'], ['overdue', '已逾期'], ['returned', '被退回'], ['done', '已办理']];
const TAB_KEY = 'kudesi.todos.tab';
const EMPTY: Record<Tab, [string, string]> = {
  pending: ['没有待办，歇一会儿', '新的待办会出现在这里，也会在右上角“通知”里提醒你。'],
  overdue: ['没有逾期的事项', '做得很好。逾期的待办会自动出现在这里。'],
  returned: ['没有被退回的事项', '别人把流程退回给你修改时，会出现在这里。'],
  done: ['还没有办理过的事项', '你办完的事项会保留在这里，方便回头查。'],
};

/** 我的待办：只列“这一步有你的未完成待办”的流程。记住上次看的分类；支持搜索；逾期标红并说明超了多久。 */
export function MyTodosPage() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => { const t = remember.get(TAB_KEY, 'pending') as Tab; return TABS.some(([k]) => k === t) ? t : 'pending'; });
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const kw = useDebounced(keyword.trim(), 300);
  const [data, setData] = useState<TodoList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [finish, setFinish] = useState<TodoRow | null>(null);
  const [delay, setDelay] = useState<TodoRow | null>(null);
  const open = Number(params.get('run')) || null;

  const load = useCallback(() => {
    setLoading(true);
    flowApi.todos({ tab, keyword: kw || undefined, page })
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [tab, kw, page]);
  useEffect(load, [load]);
  const pick = (k: Tab) => { setTab(k); setPage(1); remember.set(TAB_KEY, k); };
  const count = (k: Tab) => (data && k !== 'done' ? ` (${data.counts[k]})` : '');
  const now = Date.now();

  return (
    <div>
      <div className="page-head">
        <h1>我的待办</h1>
        <div className="row-actions">
          {data && (data.counts.taskReview ?? 0) > 0 && <Link to="/workbench/tasks" className="pill warn">任务待我复核/处理 {data.counts.taskReview} 条</Link>}
          {data && data.counts.cc > 0 && <Link to="/workbench/cc" className="muted">抄送我的 {data.counts.cc} 条</Link>}
          <button type="button" className="secondary-button" disabled={loading} onClick={load}>{loading ? '刷新中…' : '刷新'}</button>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'tab active' : 'tab'} onClick={() => pick(k)}>{label}{count(k)}</button>)}
      </div>
      <div className="toolbar">
        <input type="search" className="search-input" aria-label="搜索待办" placeholder="搜索事项名称" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
        {keyword && <button type="button" className="secondary-button" onClick={() => setKeyword('')}>清除搜索</button>}
      </div>
      {notice && <div role="status" className="notice ok-notice toast-line"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>✕</button></div>}
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      <div className="table-scroll"><table className="data-table stack-mobile">
        <thead><tr><th>事项</th><th>类型</th><th>当前步骤</th><th>发起人</th><th>{tab === 'done' ? '办理时间' : '截止'}</th><th /></tr></thead>
        <tbody>
          {loading && !data && <tr><td colSpan={6} className="empty-state muted">正在加载…</td></tr>}
          {data?.rows.length === 0 && (
            <tr><td colSpan={6} className="empty-state muted">
              <strong>{kw ? '没有匹配的事项' : EMPTY[tab][0]}</strong>
              <span>{kw ? '换个关键词试试，或清除搜索。' : EMPTY[tab][1]}</span>
              {kw && <button type="button" className="secondary-button" onClick={() => setKeyword('')}>清除搜索</button>}
            </td></tr>
          )}
          {data?.rows.map((r) => {
            const hint = dueHint(r.dueAt, now);
            const late = r.overdue && tab !== 'done';
            return (
              <tr key={r.id} className={late ? 'late' : undefined}>
                <td className="cell-title">{r.runId
                  ? <button type="button" className="link-button" onClick={() => setParams({ run: String(r.runId) })}>{r.enteredVia === 'return' && <span className="pill warn">被退回</span>} {r.runTitle}</button>
                  : <><strong>{r.runTitle}</strong>{r.description && <span className="sub-line">{r.description}</span>}{r.completionStandard && <span className="sub-line">完成标准：{r.completionStandard}</span>}{r.reviewComment && r.status === 'open' && <span className="sub-line late-text">被退回：{r.reviewComment}</span>}</>}</td>
                <td data-label="类型">{r.templateLabel}</td>
                <td data-label="当前步骤">{r.stepName ?? ''}</td>
                <td data-label="发起人">{r.requesterName}</td>
                <td data-label={tab === 'done' ? '办理时间' : '截止'}>
                  {tab === 'done' ? fmtTime(r.finishedAt) : r.dueAt
                    ? <span>{fmtTime(r.dueAt)}<span className={`sub-line${hint.late ? ' late-text' : ''}`}>{hint.text}</span></span>
                    : '不限时'}
                </td>
                <td className="row-actions">
                  {r.runId
                    ? <button type="button" className={tab === 'done' ? 'secondary-button small' : 'primary-button'} onClick={() => setParams({ run: String(r.runId) })}>{tab === 'done' ? '查看' : '去办理'}</button>
                    : tab !== 'done' && <>
                      <button type="button" className="secondary-button small" onClick={() => setFinish(r)}>{r.requiresReview ? '提交' : '完成'}</button>
                      {r.dueAt && <button type="button" className="link-button" onClick={() => setDelay(r)}>申请延期</button>}
                    </>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      {data && <Pager page={page} pageSize={20} total={data.total} onPage={setPage} />}
      {finish && <SubmitTaskDialog task={{ id: finish.id, title: finish.runTitle, feedbackPreset: finish.feedbackPreset, completionStandard: finish.completionStandard, requiresReview: finish.requiresReview }} onClose={() => setFinish(null)} onDone={(st) => { setFinish(null); setNotice(st === 'reviewing' ? '已提交，等监督人复核' : st === 'abnormal' ? '已异常提交，等监督人处理' : '任务已完成'); load(); }} />}
      {delay && <DelayDialog task={{ id: delay.id, title: delay.runTitle }} onClose={() => setDelay(null)} onDone={() => { setDelay(null); setNotice('延期申请已提交，等监督人处理'); load(); }} />}
      {open && <RunDetail id={open} onClose={() => setParams({})} onChanged={load} />}
    </div>
  );
}
