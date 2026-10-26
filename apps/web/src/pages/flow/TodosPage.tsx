import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Pager } from '../finance/common';
import { ReasonDialog } from '../../resources/RecordForm';
import { RunDetail } from './RunDetail';
import { flowApi, fmtTime, type TodoList } from './flowApi';

const TABS: Array<['pending' | 'overdue' | 'returned' | 'done', string]> = [['pending', '待办理'], ['overdue', '已逾期'], ['returned', '被退回'], ['done', '已办理']];

/** 我的待办：只列“这一步有你的未完成待办”的流程。 */
export function MyTodosPage() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'pending' | 'overdue' | 'returned' | 'done'>('pending');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TodoList | null>(null);
  const [error, setError] = useState('');
  const [finish, setFinish] = useState<number | null>(null);
  const open = Number(params.get('run')) || null;
  const load = useCallback(() => {
    flowApi.todos({ tab, page }).then(setData).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [tab, page]);
  useEffect(load, [load]);
  const count = (k: string) => (data && k !== 'done' ? ` (${data.counts[k as 'pending' | 'overdue' | 'returned']})` : '');

  return (
    <div>
      <div className="page-head"><h1>我的待办</h1></div>
      <div className="tabs">
        {TABS.map(([k, label]) => <button key={k} type="button" className={tab === k ? 'tab active' : 'tab'} onClick={() => { setTab(k); setPage(1); }}>{label}{count(k)}</button>)}
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>事项</th><th>类型</th><th>当前步骤</th><th>发起人</th><th>{tab === 'done' ? '办理时间' : '截止'}</th></tr></thead>
        <tbody>
          {data?.rows.length === 0 && <tr><td colSpan={5} className="empty-state muted">{tab === 'done' ? '还没有办理过的事项' : '没有待办，歇一会儿'}</td></tr>}
          {data?.rows.map((r) => (
            <tr key={r.id}>
              <td>{r.runId
                ? <button type="button" className="link-button" onClick={() => setParams({ run: String(r.runId) })}>{r.enteredVia === 'return' && <span className="pill warn">被退回</span>} {r.runTitle}</button>
                : <><strong>{r.runTitle}</strong>{r.description && <div className="muted">{r.description}</div>}{tab !== 'done' && <button type="button" className="secondary-button" onClick={() => setFinish(r.id)}>完成</button>}</>}</td>
              <td>{r.templateLabel}</td><td>{r.stepName ?? ''}</td><td>{r.requesterName}</td>
              <td>{tab === 'done' ? fmtTime(r.finishedAt) : r.dueAt ? <span className={r.overdue ? 'pill bad' : ''}>{fmtTime(r.dueAt)}{r.overdue && ' 已逾期'}</span> : '不限时'}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {data && <Pager page={page} pageSize={20} total={data.total} onPage={setPage} />}
      {finish && <ReasonDialog title="完成任务" hint="写一句完成情况。" confirmLabel="完成" onClose={() => setFinish(null)} onConfirm={async (note) => { await flowApi.completeTask(finish, note); setFinish(null); load(); }} />}
      {open && <RunDetail id={open} onClose={() => setParams({})} onChanged={load} />}
    </div>
  );
}
