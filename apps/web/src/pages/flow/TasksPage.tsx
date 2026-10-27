import { useCallback, useEffect, useState } from 'react';
import { ROUTINE_FREQUENCY_LABEL, WEEKDAY_LABEL } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { loadRefOptions } from '../../resources/RecordForm';
import { Pager } from '../finance/common';
import { flowApi, fmtTime, type AssignedRow, type RoutineBody, type RoutineDto } from './flowApi';
import { dueHint, remember } from './flowUi';

type Opt = { value: number; label: string; disabled?: boolean };
const STATUS: Record<string, [string, string]> = { open: ['进行中', 'warn'], done: ['已完成', 'ok'], cancelled: ['已取消', ''] };

/** 任务中心：新建任务（自己或指派别人）、看我指派的任务进度、管理周期任务。 */
export function TasksPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'assigned' | 'routines'>('assigned');
  const [users, setUsers] = useState<Opt[]>([]);
  useEffect(() => { loadRefOptions('user').then(setUsers).catch(() => undefined); }, []);
  return (
    <div>
      <div className="page-head"><h1>任务中心</h1></div>
      <p className="muted">分给你的任务和流程待办都在“我的待办”里办理；这里新建任务、看你指派出去的任务进度{can('tasks.routines.manage') ? '、管理周期任务' : ''}。</p>
      <div className="tabs">
        <button type="button" className={tab === 'assigned' ? 'tab active' : 'tab'} onClick={() => setTab('assigned')}>我指派的任务</button>
        {can('tasks.routines.manage') && <button type="button" className={tab === 'routines' ? 'tab active' : 'tab'} onClick={() => setTab('routines')}>周期任务</button>}
      </div>
      {tab === 'assigned' ? <Assigned users={users} canAssign={can('tasks.assign')} /> : <Routines users={users} />}
    </div>
  );
}

const STATUS_CHIPS: Array<[string, string]> = [['', '全部'], ['open', '进行中'], ['done', '已完成'], ['cancelled', '已取消']];

function Assigned({ users, canAssign }: { users: Opt[]; canAssign: boolean }) {
  const [status, setStatus] = useState(() => remember.get('kudesi.tasks.status', 'open') === 'all' ? '' : remember.get('kudesi.tasks.status', 'open'));
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: AssignedRow[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState<AssignedRow | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    flowApi.assigned({ status, page }).then((d) => { setData(d); setError(''); }).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')).finally(() => setLoading(false));
  }, [status, page]);
  useEffect(load, [load]);
  const pick = (v: string) => { setStatus(v); setPage(1); remember.set('kudesi.tasks.status', v || 'all'); };
  const now = Date.now();
  return (
    <div>
      <div className="toolbar">
        <div className="chip-row" role="group" aria-label="任务状态">
          {STATUS_CHIPS.map(([v, label]) => <button key={v || 'all'} type="button" aria-pressed={status === v} className={status === v ? 'chip active' : 'chip'} onClick={() => pick(v)}>{label}</button>)}
        </div>
        <button type="button" className="secondary-button" disabled={loading} onClick={load}>刷新</button>
        <button type="button" className="primary-button" onClick={() => setCreating(true)}>新建任务</button>
      </div>
      {notice && <div role="status" className="notice ok-notice toast-line"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>✕</button></div>}
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      <div className="table-scroll"><table className="data-table stack-mobile">
        <thead><tr><th>任务</th><th>负责人</th><th>状态</th><th>截止</th><th>完成情况</th><th /></tr></thead>
        <tbody>
          {loading && !data && <tr><td colSpan={6} className="empty-state muted">正在加载…</td></tr>}
          {data?.rows.length === 0 && (
            <tr><td colSpan={6} className="empty-state muted">
              <strong>{status ? `没有${STATUS_CHIPS.find(([v]) => v === status)?.[1]}的任务` : '还没有任务'}</strong>
              <span>点右上角“新建任务”，给自己或同事安排一件事；到期前负责人会收到提醒。</span>
              {status && <button type="button" className="secondary-button" onClick={() => pick('')}>查看全部任务</button>}
            </td></tr>
          )}
          {data?.rows.map((r) => {
            const hint = dueHint(r.dueAt, now);
            return (
              <tr key={r.id} className={r.overdue && r.status === 'open' ? 'late' : undefined}>
                <td className="cell-title"><strong>{r.title}</strong>{r.description && <span className="sub-line">{r.description}</span>}</td>
                <td data-label="负责人">{r.assigneeName}</td>
                <td data-label="状态"><span className={`pill ${STATUS[r.status]?.[1] ?? ''}`}>{STATUS[r.status]?.[0] ?? r.status}</span></td>
                <td data-label="截止">{r.dueAt ? <span>{fmtTime(r.dueAt)}{r.status === 'open' && <span className={`sub-line${hint.late ? ' late-text' : ''}`}>{hint.text}</span>}</span> : '不限时'}</td>
                <td data-label="完成情况">{r.doneNote ?? ''}</td>
                <td>{r.status === 'open' && <button type="button" className="link-button" onClick={() => setCancelling(r)}>取消</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      {data && <Pager page={page} pageSize={20} total={data.total} onPage={setPage} />}
      {creating && <NewTask users={users} canAssign={canAssign} onClose={() => setCreating(false)} onSaved={(who) => { setCreating(false); setNotice(who ? `已分派给 ${who}，对方会在“我的待办”里看到。` : '已创建，在“我的待办”里办理。'); load(); }} />}
      {cancelling && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal card small" role="alertdialog" aria-label="取消任务">
            <div className="modal-head"><strong>取消任务</strong></div>
            <div className="modal-body"><p>确定取消「{cancelling.title}」吗？负责人（{cancelling.assigneeName}）的待办会一并消失。</p></div>
            <div className="modal-foot">
              <button type="button" className="secondary-button" onClick={() => setCancelling(null)}>先不取消</button>
              <button type="button" className="primary-button" onClick={() => { const id = cancelling.id; setCancelling(null); flowApi.cancelTask(id).then(() => { setNotice('任务已取消'); load(); }).catch((e) => setError(e instanceof ApiError ? e.message : '操作失败')); }}>确认取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NewTask({ users, canAssign, onClose, onSaved }: { users: Opt[]; canAssign: boolean; onClose: () => void; onSaved: (assignee?: string) => void }) {
  const [v, setV] = useState({ title: '', description: '', assigneeId: '' as number | '', dueDate: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="新建任务" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError('');
        if (!v.title.trim()) { setBusy(false); return setError('请填写任务标题'); }
        try { await flowApi.createTask({ title: v.title.trim(), description: v.description || undefined, assigneeId: v.assigneeId || undefined, dueDate: v.dueDate || undefined }); onSaved(v.assigneeId ? users.find((u) => u.value === v.assigneeId)?.label : undefined); }
        catch (err) { setError(err instanceof ApiError ? err.message : '保存失败'); setBusy(false); }
      }}>
        <div className="modal-head"><strong>新建任务</strong></div>
        <div className="modal-body">
          <label>标题 *<input value={v.title} maxLength={150} onChange={(e) => setV({ ...v, title: e.target.value })} /></label>
          <label>说明<textarea rows={3} value={v.description} maxLength={1000} onChange={(e) => setV({ ...v, description: e.target.value })} /></label>
          <label>负责人
            <select value={v.assigneeId} disabled={!canAssign} onChange={(e) => setV({ ...v, assigneeId: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">{canAssign ? '我自己' : '我自己（没有指派别人的权限）'}</option>
              {canAssign && users.filter((u) => !u.disabled).map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          </label>
          <label>截止日期（选填，不填则不限时）<input type="date" min={new Date().toISOString().slice(0, 10)} value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} /></label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>创建</button></div>
      </form>
    </div>
  );
}

const blank = (): RoutineBody => ({ title: '', description: '', assigneeId: 0, frequency: 'daily', weekday: 1, monthDay: 1, dueDays: 1 });

function Routines({ users }: { users: Opt[] }) {
  const [rows, setRows] = useState<RoutineDto[] | null>(null);
  const [edit, setEdit] = useState<{ id: number | null; body: RoutineBody } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { flowApi.routines().then(setRows).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, []);
  useEffect(load, [load]);
  const when = (r: RoutineDto) => r.frequency === 'weekly' ? `每${WEEKDAY_LABEL[r.weekday ?? 1]}` : r.frequency === 'monthly' ? `每月 ${r.monthDay} 号` : '每天';
  return (
    <div>
      <p className="muted">到点（北京时间当天）自动给负责人生成一条任务；服务当天没运行就错过当天，不补发过期的。负责人停用后不再生成，请改负责人。</p>
      <div className="toolbar"><button type="button" className="primary-button" onClick={() => setEdit({ id: null, body: blank() })}>新建周期任务</button></div>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="table-scroll"><table className="data-table stack-mobile">
        <thead><tr><th>任务</th><th>频率</th><th>负责人</th><th>完成期限</th><th>状态</th><th /></tr></thead>
        <tbody>
          {rows?.length === 0 && <tr><td colSpan={6} className="empty-state muted">还没有周期任务</td></tr>}
          {rows?.map((r) => (
            <tr key={r.id}>
              <td className="cell-title"><strong>{r.title}</strong>{r.description && <div className="muted">{r.description}</div>}</td>
              <td data-label="频率">{when(r)}</td><td data-label="负责人">{r.assigneeName}</td><td data-label="完成期限">{r.dueDays} 天</td>
              <td data-label="状态"><span className={`pill ${r.active ? 'ok' : ''}`}>{r.active ? '启用' : '已停用'}</span></td>
              <td className="row-actions">
                <button type="button" className="link-button" onClick={() => setEdit({ id: r.id, body: { title: r.title, description: r.description ?? '', assigneeId: r.assigneeId, frequency: r.frequency, weekday: r.weekday, monthDay: r.monthDay, dueDays: r.dueDays, active: r.active } })}>修改</button>
                <button type="button" className="link-button" onClick={() => flowApi.setRoutineActive(r.id, !r.active).then(load).catch((e) => setError(e instanceof ApiError ? e.message : '操作失败'))}>{r.active ? '停用' : '启用'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {edit && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal card small" role="dialog" aria-label="周期任务" onSubmit={async (e) => {
            e.preventDefault();
            try { await flowApi.saveRoutine(edit.id, edit.body); setEdit(null); load(); } catch (err) { setError(err instanceof ApiError ? err.message : '保存失败'); }
          }}>
            <div className="modal-head"><strong>{edit.id ? '修改周期任务' : '新建周期任务'}</strong></div>
            <div className="modal-body">
              <label>标题 *<input value={edit.body.title} maxLength={150} onChange={(e) => setEdit({ ...edit, body: { ...edit.body, title: e.target.value } })} /></label>
              <label>说明<textarea rows={2} value={edit.body.description ?? ''} onChange={(e) => setEdit({ ...edit, body: { ...edit.body, description: e.target.value } })} /></label>
              <label>负责人 *
                <select value={edit.body.assigneeId || ''} onChange={(e) => setEdit({ ...edit, body: { ...edit.body, assigneeId: Number(e.target.value) } })}>
                  <option value="">（选择员工）</option>{users.filter((u) => !u.disabled || u.value === edit.body.assigneeId).map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                </select>
              </label>
              <label>频率
                <select value={edit.body.frequency} onChange={(e) => setEdit({ ...edit, body: { ...edit.body, frequency: e.target.value } })}>
                  {Object.entries(ROUTINE_FREQUENCY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              {edit.body.frequency === 'weekly' && <label>周几<select value={edit.body.weekday ?? 1} onChange={(e) => setEdit({ ...edit, body: { ...edit.body, weekday: Number(e.target.value) } })}>{[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{WEEKDAY_LABEL[n]}</option>)}</select></label>}
              {edit.body.frequency === 'monthly' && <label>每月几号（1–28）<input type="number" min={1} max={28} value={edit.body.monthDay ?? 1} onChange={(e) => setEdit({ ...edit, body: { ...edit.body, monthDay: Number(e.target.value) } })} /></label>}
              <label>完成期限（天，1–30）<input type="number" min={1} max={30} value={edit.body.dueDays} onChange={(e) => setEdit({ ...edit, body: { ...edit.body, dueDays: Number(e.target.value) } })} /></label>
            </div>
            <div className="modal-foot"><button type="button" className="secondary-button" onClick={() => setEdit(null)}>取消</button><button type="submit" className="primary-button">保存</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
