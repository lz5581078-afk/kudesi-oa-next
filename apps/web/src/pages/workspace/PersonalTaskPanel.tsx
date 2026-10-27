import { useCallback, useEffect, useState } from 'react';
import { TASK_VIEWS, type PersonalTaskList, type PersonalTaskRow, type TaskView } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { Pager } from '../finance/common';
import { flowApi, fmtTime } from '../flow/flowApi';
import { dueHint } from '../flow/flowUi';
import { workspaceApi } from './workspaceApi';

const STAGE: Record<PersonalTaskRow['stage'], [string, string]> = {
  new: ['新任务', ''], processing: ['进行中', 'warn'], submitted: ['待复核', 'warn'], done: ['已完成', 'ok'], cancelled: ['已取消', ''],
};
const errText = (e: unknown) => (e instanceof ApiError ? e.message : '操作失败，请重试');

/** 个人任务面板：新任务 / 进行中 / 待我复核 / 已完成 四类，点任务看详情并办理。 */
export function PersonalTaskPanel({ refreshKey = 0, onChanged }: { refreshKey?: number; onChanged?: () => void }) {
  const [view, setView] = useState<TaskView>('new');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PersonalTaskList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<PersonalTaskRow | null>(null);
  const [notice, setNotice] = useState('');
  const load = useCallback(() => {
    setLoading(true);
    workspaceApi.tasks({ view, page }).then((d) => { setData(d); setError(''); }).catch((e) => setError(errText(e))).finally(() => setLoading(false));
  }, [view, page]);
  useEffect(load, [load, refreshKey]);
  const now = Date.now();
  const done = (msg: string) => { setOpen(null); setNotice(msg); load(); onChanged?.(); };
  return (
    <section className="card ws-section ws-tasks" aria-label="个人任务">
      <div className="ws-head"><h2>个人任务</h2><button type="button" className="secondary-button small" disabled={loading} onClick={load}>刷新</button></div>
      <div className="tabs" role="tablist" aria-label="个人任务分类">
        {TASK_VIEWS.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={view === t.key} className={view === t.key ? 'tab active' : 'tab'} onClick={() => { setView(t.key); setPage(1); }}>
            {t.label}<span className="ws-count">{data?.counts[t.key] ?? '—'}</span>
          </button>
        ))}
      </div>
      {notice && <div role="status" className="notice ok-notice toast-line"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>✕</button></div>}
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      <ul className="ws-task-list" aria-busy={loading}>
        {data?.rows.map((t) => {
          const hint = dueHint(t.dueAt, now);
          const [label, tone] = t.overdue ? ['已超时', 'bad'] : STAGE[t.stage];
          return (
            <li key={t.id}>
              <button type="button" className="ws-task" onClick={() => setOpen(t)}>
                <span className="ws-task-main"><strong>{t.title}</strong>
                  <small>{view === 'review' ? `${t.assigneeName} · ` : t.creatorName && t.creatorId !== t.assigneeId ? `${t.creatorName} 指派 · ` : ''}{t.dueAt ? `截止 ${fmtTime(t.dueAt)}${t.status === 'open' ? ` · ${hint.text}` : ''}` : '不限时'}</small></span>
                <span className={`pill ${tone}`}>{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {loading && !data && <p className="muted ws-pad" role="status">正在读取个人任务…</p>}
      {data && data.rows.length === 0 && !error && <div className="ws-empty muted"><strong>暂无{TASK_VIEWS.find((t) => t.key === view)!.label}</strong>{view === 'new' && <span>别人指派给你的、或周期任务生成的任务会出现在这里。</span>}</div>}
      {data && data.total > data.pageSize && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
      {open && <TaskDialog task={open} onClose={() => setOpen(null)} onDone={done} />}
    </section>
  );
}

function TaskDialog({ task, onClose, onDone }: { task: PersonalTaskRow; onClose: () => void; onDone: (msg: string) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'' | 'complete' | 'submit' | 'approve' | 'reject'>('');
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true); setErr('');
    try { await fn(); onDone(msg); } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  const [label] = STAGE[task.stage];
  const confirm = () => {
    if (mode === 'complete') return run(() => flowApi.completeTask(task.id, note.trim() || undefined), '任务已完成');
    if (mode === 'submit') return run(() => workspaceApi.submitTask(task.id, note.trim() || undefined), '已提交复核，指派人会收到通知');
    if (mode === 'approve') return run(() => workspaceApi.reviewTask(task.id, true, note.trim() || undefined), '已复核通过，任务完成');
    if (mode === 'reject') {
      if (!note.trim()) return setErr('退回要写明原因');
      return run(() => workspaceApi.reviewTask(task.id, false, note.trim()), '已退回给负责人');
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal card" role="dialog" aria-label="任务详情" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><strong>{task.title}</strong></div>
        <div className="modal-body">
          <dl className="ws-dl">
            <dt>状态</dt><dd>{task.overdue ? `${label}（已超时）` : label}</dd>
            <dt>负责人</dt><dd>{task.assigneeName}</dd>
            <dt>指派人</dt><dd>{task.creatorName || '周期任务自动生成'}</dd>
            <dt>截止</dt><dd>{task.dueAt ? fmtTime(task.dueAt) : '不限时'}</dd>
            {task.startedAt && <><dt>开始处理</dt><dd>{fmtTime(task.startedAt)}</dd></>}
            {task.submittedAt && <><dt>提交复核</dt><dd>{fmtTime(task.submittedAt)}</dd></>}
          </dl>
          {task.description && <p className="ws-pre">{task.description}</p>}
          {task.doneNote && <p><span className="muted">处理说明：</span>{task.doneNote}</p>}
          {task.reviewNote && <p><span className="muted">复核意见：</span>{task.reviewNote}</p>}
          {mode && (
            <label>{mode === 'reject' ? '退回原因（必填）' : mode === 'approve' ? '复核意见（可不填）' : '处理说明（可不填）'}
              <textarea autoFocus rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          )}
          {err && <div role="alert" className="notice error">{err}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={mode ? () => { setMode(''); setErr(''); } : onClose}>{mode ? '返回' : '关闭'}</button>
          {mode ? <button type="button" className="primary-button" disabled={busy} onClick={confirm}>确认</button> : (
            <>
              {task.can.start && <button type="button" className="secondary-button" disabled={busy} onClick={() => run(() => workspaceApi.startTask(task.id), '已开始处理，任务在“进行中”')}>开始处理</button>}
              {task.can.submit && <button type="button" className="secondary-button" onClick={() => setMode('submit')}>提交复核</button>}
              {task.can.complete && <button type="button" className="primary-button" onClick={() => setMode('complete')}>完成</button>}
              {task.can.review && <button type="button" className="secondary-button" onClick={() => setMode('reject')}>退回</button>}
              {task.can.review && <button type="button" className="primary-button" onClick={() => setMode('approve')}>复核通过</button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
