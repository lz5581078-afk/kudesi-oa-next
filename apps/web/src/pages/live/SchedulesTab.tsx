import { useCallback, useEffect, useMemo, useState } from 'react';
import { liveApi, type Options, type ScheduleBody, type ScheduleList, type ScheduleRow } from './liveApi';
import { errText, nowText, todayText } from './liveFormat';
import { Modal, SchedulePill } from './liveUi';

const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const dayLabel = (day: string) => `${day.slice(5)} 周${WEEK[new Date(`${day}T00:00:00Z`).getUTCDay()]}`;

/** 到点状态：已到时间未上播 / 已过时未上播（只对未开始的排场） */
function stateOf(s: ScheduleRow, now: string): { label: string; tone: string } {
  if (s.status !== 'scheduled') return { label: s.statusLabel, tone: '' };
  if (s.end <= now) return { label: '已过时未上播', tone: 'bad' };
  if (s.start <= now) return { label: '已到时间未上播', tone: 'warn' };
  return { label: s.statusLabel, tone: '' };
}

function ScheduleDialog({ initial, days, onClose, onDone }: { initial: ScheduleRow | null; days: string[]; onClose: () => void; onDone: () => void }) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [f, setF] = useState({
    date: initial?.date ?? days[0], roomId: initial ? String(initial.roomId) : '', startTime: initial?.startTime ?? '', endTime: initial?.endTime ?? '', anchorId: initial ? String(initial.anchor.id) : '',
    controlId: initial?.control ? String(initial.control.id) : '', operatorId: initial?.operator ? String(initial.operator.id) : '', douyinAccountId: initial ? String(initial.douyinAccount.id) : '', storeId: initial?.store ? String(initial.store.id) : '', note: initial?.note ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { liveApi.options().then(setOpts).catch((e) => setError(errText(e, '加载选项失败'))); }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  async function save() {
    setError('');
    if (!f.roomId || !f.startTime || !f.endTime || !f.anchorId || !f.douyinAccountId) return setError('请填写直播间、开始结束时间、主播和抖音号');
    const body: ScheduleBody = { date: f.date, roomId: Number(f.roomId), startTime: f.startTime, endTime: f.endTime, anchorId: Number(f.anchorId), controlId: f.controlId ? Number(f.controlId) : null, operatorId: f.operatorId ? Number(f.operatorId) : null, douyinAccountId: Number(f.douyinAccountId), storeId: f.storeId ? Number(f.storeId) : null, note: f.note.trim() || undefined };
    setBusy(true);
    try { if (initial) await liveApi.updateSchedule(initial.id, body); else await liveApi.createSchedule(body); onDone(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={initial ? '修改排场' : '新增排场'} onClose={onClose} foot={<><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || !opts} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></>}>
      {error && <div role="alert" className="notice error">{error}</div>}
      <p className="muted">结束时间早于开始时间表示跨到第二天；单场最长 16 小时；同一直播间时间段不能重叠，同一主播不能同时在两个房间。</p>
      {!opts ? <p className="muted" role="status">正在读取选项…</p> : (
        <div className="live-fields">
          <label className="live-field">日期<select aria-label="排场日期" value={f.date} onChange={set('date')}>{days.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}</select></label>
          <label className="live-field">直播间<select aria-label="直播间" value={f.roomId} onChange={set('roomId')}><option value="">请选择</option>{opts.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <label className="live-field">开始时间<input aria-label="开始时间" type="time" value={f.startTime} onChange={set('startTime')} /></label>
          <label className="live-field">结束时间<input aria-label="结束时间" type="time" value={f.endTime} onChange={set('endTime')} /></label>
          <label className="live-field">主播<select aria-label="主播" value={f.anchorId} onChange={set('anchorId')}><option value="">请选择</option>{opts.anchors.map((p) => <option key={p.id} value={p.id}>{p.name}{p.partTime ? '（兼职）' : ''}</option>)}</select></label>
          <label className="live-field">中控（可选）<select aria-label="中控" value={f.controlId} onChange={set('controlId')}><option value="">无</option>{opts.controls.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="live-field">运营（可选）<select aria-label="运营" value={f.operatorId} onChange={set('operatorId')}><option value="">无</option>{opts.operators.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="live-field">抖音号<select aria-label="抖音号" value={f.douyinAccountId} onChange={set('douyinAccountId')}><option value="">请选择</option>{opts.douyinAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="live-field">抖音店铺（可选）<select aria-label="店铺" value={f.storeId} onChange={set('storeId')}><option value="">无</option>{opts.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="live-field wide">备注（可选）<input aria-label="备注" maxLength={500} value={f.note} onChange={set('note')} /></label>
        </div>
      )}
    </Modal>
  );
}

function CancelDialog({ row, onClose, onDone }: { row: ScheduleRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  async function go() {
    if (!reason.trim()) return setError('请填写取消排场的原因');
    try { await liveApi.cancelSchedule(row.id, reason.trim()); onDone(); } catch (e) { setError(errText(e)); }
  }
  return (
    <Modal title="取消排场" size="small" onClose={onClose} foot={<><button type="button" className="secondary-button" onClick={onClose}>返回</button><button type="button" className="primary-button danger-fill" onClick={() => void go()}>确认取消</button></>}>
      {error && <div role="alert" className="notice error">{error}</div>}
      <p>{row.date} {row.startTime}–{row.endTime} · {row.roomName} · 主播 {row.anchor.name}。取消后会通知相关人员。</p>
      <label className="live-field">取消原因（必填）<textarea aria-label="取消原因" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    </Modal>
  );
}

/** 排场：今天及未来 7 天，按天分页签、按直播间分块。 */
export function SchedulesTab() {
  const today = todayText();
  const days = useMemo(() => Array.from({ length: 8 }, (_, i) => addDays(today, i)), [today]);
  const [day, setDay] = useState(today);
  const [showCancelled, setShowCancelled] = useState(false);
  const [d, setD] = useState<ScheduleList | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ScheduleRow | 'new' | null>(null);
  const [cancelling, setCancelling] = useState<ScheduleRow | null>(null);
  const load = useCallback(() => { liveApi.schedules({ from: days[0], to: days[7] }).then((x) => { setD(x); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, [days]);
  useEffect(load, [load]);
  const now = nowText();
  const rows = (d?.rows ?? []).filter((r) => r.date === day && (showCancelled || r.status !== 'cancelled'));
  const byRoom = new Map<number, { name: string; rows: ScheduleRow[] }>();
  for (const r of rows) { const g = byRoom.get(r.roomId) ?? { name: r.roomName, rows: [] }; g.rows.push(r); byRoom.set(r.roomId, g); }
  const counts = (x: string) => (d?.rows ?? []).filter((r) => r.date === x && r.status !== 'cancelled').length;
  return (
    <div className="live-page">
      <div className="live-filter card">
        <div className="tab-group" role="tablist" aria-label="日期">{days.map((x) => <button key={x} type="button" role="tab" aria-selected={x === day} className={x === day ? 'chip active' : 'chip'} onClick={() => setDay(x)}>{x === today ? '今天' : dayLabel(x)}{counts(x) ? ` · ${counts(x)}` : ''}</button>)}</div>
        <label className="live-field"><span><input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> 显示已取消</span></label>
        {d?.canManage && <button type="button" className="primary-button" onClick={() => setEditing('new')}>新增排场</button>}
      </div>
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      {!d && !error && <p className="muted" role="status">正在读取…</p>}
      {d && rows.length === 0 && <div className="card pad muted" role="status">{dayLabel(day)} 没有排场。{d.canManage ? '点「新增排场」安排。' : ''}</div>}
      {[...byRoom.entries()].map(([roomId, g]) => (
        <section key={roomId} className="card live-section" aria-label={g.name}>
          <h2>{g.name}</h2>
          <ul className="live-list">{g.rows.map((s) => {
            const st = day === today || s.date <= today ? stateOf(s, now) : { label: s.statusLabel, tone: '' };
            return (
              <li key={s.id}>
                <div className="main"><strong>{s.startTime}–{s.endTime}{s.end.slice(0, 10) > s.date ? '（次日）' : ''} · 主播 {s.anchor.name}</strong><small>{s.control ? `中控 ${s.control.name}` : '无中控'}{s.operator ? ` · 运营 ${s.operator.name}` : ''} · {s.douyinAccount.name}{s.store ? ` · ${s.store.name}` : ''}{s.note ? ` · ${s.note}` : ''}{s.cancelReason ? ` · 取消原因：${s.cancelReason}` : ''}</small></div>
                {st.tone ? <span className={`pill ${st.tone}`}>{st.label}</span> : <SchedulePill status={s.status} label={st.label} />}
                {d?.canManage && s.status === 'scheduled' && <div className="live-actions"><button type="button" className="secondary-button small" onClick={() => setEditing(s)}>修改</button><button type="button" className="secondary-button small danger" onClick={() => setCancelling(s)}>取消</button></div>}
              </li>
            );
          })}</ul>
        </section>
      ))}
      {editing && <ScheduleDialog initial={editing === 'new' ? null : editing} days={days} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />}
      {cancelling && <CancelDialog row={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); load(); }} />}
    </div>
  );
}
