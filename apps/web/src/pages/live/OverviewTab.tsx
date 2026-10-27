import { useCallback, useEffect, useState } from 'react';
import { liveApi, type Overview, type RoomDay, type RoomTile, type TimelineItem } from './liveApi';
import { errText, hm, minutesText, money, todayText } from './liveFormat';
import { Modal, SchedulePill, SessionPill } from './liveUi';

const FILTERS = [['all', '全部'], ['live', '正在直播'], ['missed', '过时未上播']] as const;
const BAR_START = 6 * 60, BAR_SPAN = 20 * 60; // 06:00 到次日 02:00

/** 'YYYY-MM-DD HH:mm' → 时间条上的位置（0–100）。比 day 晚一天的算次日。 */
function barPos(t: string, day: string): number {
  const mins = Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) + (t.slice(0, 10) > day ? 24 * 60 : 0);
  return Math.max(0, Math.min(100, ((mins - BAR_START) / BAR_SPAN) * 100));
}
const STATE_LABEL: Record<TimelineItem['state'], string> = { live: '直播中', done: '已播', missed: '已过时未上播', due: '已到时间未上播', upcoming: '未开始' };

function Tile({ t, day, now, onOpen }: { t: RoomTile; day: string; now: string; onOpen: () => void }) {
  const missed = t.timeline.some((i) => i.state === 'missed' || i.state === 'due');
  return (
    <button type="button" className={`live-room ${t.big ? 'big' : ''} ${t.status === 'live' ? 'is-live' : t.status === 'finished' ? 'is-finished' : ''}`} onClick={onOpen} aria-label={`${t.name}，${t.statusLabel}`}>
      <h3><span>{t.shortName || t.name}</span><span className={`pill ${t.status === 'live' ? 'bad' : t.status === 'finished' ? 'ok' : ''}`}>{t.statusLabel}</span></h3>
      {t.live ? (
        <>
          <small>{hm(t.live.startAt)} 开播 · 已播 {minutesText(Math.max(0, Math.round((new Date(now.replace(' ', 'T')).getTime() - new Date(t.live.startAt.replace(' ', 'T')).getTime()) / 60000)))}{t.live.plannedEnd ? ` · 计划 ${hm(t.live.plannedEnd, day)} 结束` : ''}</small>
          <small>主播 {t.live.anchor.name}{t.live.operator ? ` · 运营 ${t.live.operator.name}` : ''}{t.live.control ? ` · 中控 ${t.live.control.name}` : ''}</small>
          <small>{t.live.douyinAccount.name}</small>
        </>
      ) : t.next ? <small>下一场 {hm(t.next.start)}–{hm(t.next.plannedEnd, day)} · {t.next.anchorName}</small> : <small className="muted">今天没有排场</small>}
      <div className="live-bar" aria-hidden="true">
        {t.timeline.map((i) => <i key={`${i.kind}${i.id}`} className={i.state === 'done' ? 'done' : i.state === 'missed' || i.state === 'due' ? 'missed' : ''} style={{ left: `${barPos(i.start, day)}%`, width: `${Math.max(1.5, barPos(i.end, day) - barPos(i.start, day))}%` }} />)}
        {day === now.slice(0, 10) && <b style={{ left: `${barPos(now, day)}%` }} />}
      </div>
      {missed && <small className="notice warn">有排场已到时间还没上播</small>}
      {t.timeline.slice(0, 3).map((i) => <small key={`${i.kind}${i.id}`} className="muted">{hm(i.start)}–{hm(i.end, day)} {i.anchorName}{i.kind === 'adhoc' ? '（临时）' : ''} · {STATE_LABEL[i.state]}</small>)}
      {t.timeline.length > 3 && <small className="muted">还有 {t.timeline.length - 3} 场…</small>}
    </button>
  );
}

function RoomDayDialog({ roomId, date, onClose, onOpenSession }: { roomId: number; date: string; onClose: () => void; onOpenSession: (id: number) => void }) {
  const [d, setD] = useState<RoomDay | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { liveApi.roomDay(roomId, date).then(setD).catch((e) => setError(errText(e, '读取失败'))); }, [roomId, date]);
  return (
    <Modal title={d ? `${d.room.name} · ${d.date}` : '直播间'} onClose={onClose}>
      {error && <div role="alert" className="notice error">{error}</div>}
      {!d && !error && <p className="muted" role="status">正在读取…</p>}
      {d && (
        <>
          <strong>排场</strong>
          {d.schedules.length === 0 && <p className="muted">这天没有排场。</p>}
          <ul className="live-list">{d.schedules.map((s) => (
            <li key={s.id}><div className="main"><strong>{s.startTime}–{s.endTime} · 主播 {s.anchor.name}</strong><small>{s.control ? `中控 ${s.control.name} · ` : ''}{s.douyinAccount.name}{s.note ? ` · ${s.note}` : ''}</small></div><SchedulePill status={s.status} label={s.statusLabel} /></li>
          ))}</ul>
          <strong>实际直播</strong>
          {d.sessions.length === 0 && <p className="muted">这天还没有直播记录。</p>}
          <ul className="live-list">{d.sessions.map((s) => (
            <li key={s.id}><div className="main"><strong>{hm(s.startAt)}–{s.endAt ? hm(s.endAt, d.date) : '直播中'} · {s.anchor.name}</strong><small>{s.finalSalesCents !== null ? `销售额 ${money(s.finalSalesCents)}` : s.anchorSalesCents !== null ? `主播所报 ${money(s.anchorSalesCents)}` : '未报下播'}</small></div>
              <SessionPill status={s.status} label={({ live: '直播中', pending_report: '待提交审核', submitted: '待审核', returned: '已退回', approved: '已审核' } as Record<string, string>)[s.status] ?? s.status} />
              <button type="button" className="secondary-button small" onClick={() => onOpenSession(s.id)}>详情</button></li>
          ))}</ul>
        </>
      )}
    </Modal>
  );
}

/** 全览：西走廊平面（南北两排、走廊居中、大房间双倍宽），页面可见时每 30 秒自动刷新。 */
export function OverviewTab({ onOpenSession }: { onOpenSession: (id: number) => void }) {
  const [date, setDate] = useState(todayText());
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const [d, setD] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [room, setRoom] = useState<number | null>(null);
  const load = useCallback(() => { liveApi.overview(date).then((x) => { setD(x); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, [date]);
  useEffect(load, [load]);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') load(); };
    const t = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, [load]);
  const keep = (t: RoomTile) => filter === 'all' || (filter === 'live' ? t.status === 'live' : t.timeline.some((i) => i.state === 'missed' || i.state === 'due'));
  const row = (list: RoomTile[]) => list.filter(keep);
  return (
    <div className="live-page">
      <div className="live-filter card">
        <label className="live-field">日期<input aria-label="全览日期" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <div className="tab-group" role="group" aria-label="筛选">{FILTERS.map(([k, label]) => <button key={k} type="button" className={filter === k ? 'chip active' : 'chip'} onClick={() => setFilter(k)}>{label}</button>)}</div>
        <button type="button" className="secondary-button" onClick={load}>刷新</button>
        {d && <span className="muted" role="status">数据截至 {hm(d.now)}</span>}
      </div>
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      {d && (
        <>
          <div className="live-cards" aria-label="统计">
            <div className="card live-stat"><span>正在直播</span><strong>{d.totals.live}</strong></div>
            <div className="card live-stat"><span>直播间</span><strong>{d.totals.rooms}</strong></div>
            <div className="card live-stat"><span>当天排场</span><strong>{d.totals.scheduled}</strong></div>
            <div className="card live-stat"><span>待审核场次</span><strong>{d.totals.pendingReview}</strong></div>
          </div>
          {!d.corridorFound ? (
            <div className="card pad" role="status"><strong>还没有直播间</strong><p className="muted">请到「资料 › 房间与档案位置」，在「西走廊办公室」下新建名称含「直播间」的房间（例如「直播间-北1」「直播间-南2（大房间）」），这里就会按南北两排显示。</p></div>
          ) : (
            <div className="live-floor" aria-label="西走廊平面">
              <div className="live-row">{row(d.groups.north).map((t) => <Tile key={t.id} t={t} day={d.date} now={d.now} onOpen={() => setRoom(t.id)} />)}</div>
              <div className="live-corridor" aria-hidden="true">走　廊</div>
              <div className="live-row">{row(d.groups.south).map((t) => <Tile key={t.id} t={t} day={d.date} now={d.now} onOpen={() => setRoom(t.id)} />)}</div>
              {d.groups.none.length > 0 && <div className="live-row">{row(d.groups.none).map((t) => <Tile key={t.id} t={t} day={d.date} now={d.now} onOpen={() => setRoom(t.id)} />)}</div>}
            </div>
          )}
        </>
      )}
      {room !== null && <RoomDayDialog roomId={room} date={date} onClose={() => setRoom(null)} onOpenSession={(id) => { setRoom(null); onOpenSession(id); }} />}
    </div>
  );
}
