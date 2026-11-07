import { liveFromText } from '@kudesi/shared';
import { PersonPhotoName } from './PersonPhotoName';
import { ScheduleDialog } from './ScheduleDialog';
import { productText } from './liveProducts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { liveApi, type ScheduleList, type ScheduleRow } from './liveApi';
import { errText, nowText, todayText } from './liveFormat';
import { Modal, SchedulePill } from './liveUi';

const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const dayLabel = (day: string) => `${day.slice(5)} 周${WEEK[new Date(`${day}T00:00:00Z`).getUTCDay()]}`;

function scheduleDuration(startText: string, endText: string): string {
  const start = liveFromText(startText);
  const end = liveFromText(endText);
  if (!start || !end) return '';
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (minutes <= 0) return '';
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const parts = [];
  if (hours) parts.push(`${hours} 小时`);
  if (remainingMinutes) parts.push(`${remainingMinutes} 分钟`);
  return `（${parts.join(' ')}）`;
}

/** 到点状态：已到时间未上播 / 已过时未上播（只对未开始的排场） */
function stateOf(s: ScheduleRow, now: string): { label: string; tone: string } {
  if (s.status !== 'scheduled') return { label: s.statusLabel, tone: '' };
  if (s.end <= now) return { label: '已过时未上播', tone: 'bad' };
  if (s.start <= now) return { label: '已到时间未上播', tone: 'warn' };
  return { label: s.statusLabel, tone: '' };
}

function CancelDialog({ row, onClose, onDone }: { row: ScheduleRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  async function go() {
    if (!reason.trim()) return setError('请填写取消排场的原因');
    try { await liveApi.cancelSchedule(row.id, reason.trim()); onDone(); } catch (e) { setError(errText(e)); }
  }
  return (
    <Modal error={error} title="取消排场" size="small" onClose={onClose} foot={<><button type="button" className="secondary-button" onClick={onClose}>返回</button><button type="button" className="primary-button danger-fill" onClick={() => void go()}>确认取消</button></>}>
      <p>{row.date} {row.startTime}–{row.endTime} · {row.roomName} · 主播 <PersonPhotoName personId={row.anchor.id} name={row.anchor.name}/>。取消后会通知相关人员。</p>
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
  const [defaultRoom,setDefaultRoom]=useState<number|undefined>();
  const [editing, setEditing] = useState<ScheduleRow | 'new' | null>(null);
  const [cancelling, setCancelling] = useState<ScheduleRow | null>(null);
  const load = useCallback(() => { liveApi.schedules({ from: days[0], to: days[7] }).then((x) => { setD(x); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, [days]);
  useEffect(load, [load]);
  const now = nowText();
  const rows = (d?.rows ?? []).filter((r) => r.date === day && (showCancelled || r.status !== 'cancelled'));
  const byRoom = new Map<number, { name: string; rows: ScheduleRow[] }>();
  for(const r of d?.rooms??[])byRoom.set(r.id,{name:r.name,rows:[]});
  for (const r of rows) { const g = byRoom.get(r.roomId) ?? { name: r.roomName, rows: [] }; g.rows.push(r); byRoom.set(r.roomId, g); }
  const counts = (x: string) => (d?.rows ?? []).filter((r) => r.date === x && r.status !== 'cancelled').length;
  return (
    <div className="live-page">
      <div className="live-filter card live-schedule-toolbar">
        <div className="tab-group" role="tablist" aria-label="日期">{days.map((x) => <button key={x} type="button" role="tab" aria-selected={x === day} className={x === day ? 'chip active' : 'chip'} onClick={() => setDay(x)}>{x === today ? '今天' : dayLabel(x)}{counts(x) ? ` · ${counts(x)}` : ''}</button>)}</div>
        <label className="live-field"><span><input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> 显示已取消</span></label>
        {d?.canManage && <button type="button" className="primary-button" onClick={() => {setDefaultRoom(undefined);setEditing('new');}}>新增排场</button>}
      </div>
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      {!d && !error && <p className="muted" role="status">正在读取…</p>}
      {d && byRoom.size === 0 && <div className="card pad muted" role="status">{dayLabel(day)} 没有排场。{d.canManage ? '点「新增排场」安排。' : ''}</div>}
      {[...byRoom.entries()].map(([roomId, g]) => (
        <section key={roomId} className="card live-section" aria-label={g.name}>
          <h2 className="live-section-head"><span>{g.name}<small className="muted"> · {g.rows.length} 场</small></span>{d?.canManage&&<button className="secondary-button small" onClick={()=>{setDefaultRoom(roomId);setEditing('new');}}>新增排场</button>}</h2>
          {!g.rows.length&&<p className="muted pad">当天暂无排场</p>}
          <ul className="live-list">{g.rows.map((s) => {
            const st = day === today || s.date <= today ? stateOf(s, now) : { label: s.statusLabel, tone: '' };
            return (
              <li key={s.id}>
                <div className="main"><strong>{s.startTime}–{s.endTime}{s.end.slice(0, 10) > s.date ? '（次日）' : ''}{scheduleDuration(s.start, s.end)} · 主播 <PersonPhotoName personId={s.anchor.id} name={s.anchor.name}/></strong><small>{s.control ? `中控 ${s.control.name}` : '无中控'}{s.operator ? ` · 运营 ${s.operator.name}` : ''}</small><small className="live-list-channel">{s.channels?.length ? s.channels.map(c => `${c.accountName}（${c.stores.map(store => store.name).join('、')}）`).join('；') : `${s.douyinAccount.name}${s.store ? ` · ${s.store.name}` : ''}`}</small><small>产品：{productText(s.products)}{s.note ? ` · 备注：${s.note}` : ''}{s.cancelReason ? ` · 取消原因：${s.cancelReason}` : ''}</small></div>
                {st.tone ? <span className={`pill ${st.tone}`}>{st.label}</span> : <SchedulePill status={s.status} label={st.label} />}
                {d?.canManage && s.status === 'scheduled' && <div className="live-actions"><button type="button" className="secondary-button small" onClick={() => setEditing(s)}>修改</button><button type="button" className="secondary-button small danger" onClick={() => setCancelling(s)}>取消</button></div>}
              </li>
            );
          })}</ul>
        </section>
      ))}
      {editing && <ScheduleDialog initial={editing === 'new' ? null : editing} days={days} defaultDay={day} defaultRoom={defaultRoom} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />}
      {cancelling && <CancelDialog row={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); load(); }} />}
    </div>
  );
}
