import { useCallback, useEffect, useState } from 'react';
import { liveApi, type ScheduleRow, type Workbench } from './liveApi';
import { errText, hm, money, minutesText } from './liveFormat';
import { HistoryPanel } from './HistoryPanel';
import { SchedulePill, SessionPill } from './liveUi';
import { SessionDetailDialog } from './SessionDetailDialog';
import { StartDialog } from './StartDialog';

/** 我的直播：主播、中控（运营以中控资格）自己的工作台——报上播、报下播、提交审核、本周排场、本月提成与工资。 */
export function LiveDeskPage() {
  const [d, setD] = useState<Workbench | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'desk' | 'history'>('desk');
  const [starting, setStarting] = useState<{ schedule: ScheduleRow | null } | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const load = useCallback(() => { liveApi.workbench().then((x) => { setD(x); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);
  const canStart = !!d && (d.identity.isAnchor || d.identity.isControl || d.identity.canManage);
  return (
    <div className="live-page">
      <div className="page-head">
        <div><h1>我的直播</h1><p className="muted">报上播、报下播、提交审核，查看本周排场和本月提成。</p></div>
        <div className="live-actions">
          <button type="button" className="secondary-button" onClick={load}>刷新</button>
          {canStart && <button type="button" className="primary-button" onClick={() => setStarting({ schedule: null })}>报上播（临时加场）</button>}
        </div>
      </div>
      <div className="tab-group" role="tablist" aria-label="我的直播分区">
        <button type="button" role="tab" aria-selected={tab === 'desk'} className={tab === 'desk' ? 'chip active' : 'chip'} onClick={() => setTab('desk')}>工作台</button>
        <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'chip active' : 'chip'} onClick={() => setTab('history')}>我的场次历史</button>
      </div>
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      {tab === 'history' ? <HistoryPanel onOpen={setOpenId} /> : !d && !error ? <p className="muted" role="status">正在读取…</p> : d && (
        <>
          <div className="live-cards">
            <div className="card live-stat"><span>本月提成（已审核）</span><strong>{money(d.monthCommissionCents)}</strong></div>
            <div className="card live-stat"><span>本月主播工资</span><strong>{money(d.monthWageCents)}</strong><small className="muted">{minutesText(d.monthWageMinutes)}</small></div>
            <div className="card live-stat"><span>进行中 / 待处理场次</span><strong>{d.active.length}</strong></div>
          </div>
          <section className="card live-section" aria-label="进行中的场次">
            <h2>进行中和待处理</h2>
            {d.active.length === 0 && <p className="muted pad">目前没有进行中的场次。</p>}
            <ul className="live-list">{d.active.map((s) => (
              <li key={s.id}>
                <div className="main"><strong>{s.roomName} · {s.date} {hm(s.startAt)}{s.endAt ? `–${hm(s.endAt, s.date)}` : ' 起'}</strong><small>主播 {s.anchor.name}{s.control ? `，中控 ${s.control.name}` : ''} · {s.douyinAccount.name}{s.returnReason ? ` · 退回原因：${s.returnReason}` : ''}</small></div>
                <SessionPill status={s.status} label={s.statusLabel} />
                <button type="button" className="secondary-button small" onClick={() => setOpenId(s.id)}>{s.status === 'live' ? '报下播 / 详情' : s.status === 'pending_report' || s.status === 'returned' ? '补报 / 提交审核' : '详情'}</button>
              </li>
            ))}</ul>
          </section>
          <section className="card live-section" aria-label="本周排场">
            <h2>本周排场（今天起 7 天）</h2>
            {d.schedules.length === 0 && <p className="muted pad">这几天没有安排你的排场。</p>}
            <ul className="live-list">{d.schedules.map((s) => (
              <li key={s.id}>
                <div className="main"><strong>{s.date} {s.startTime}–{s.endTime} · {s.roomName}</strong><small>我是{s.mineRole === 'anchor' ? '主播' : s.mineRole === 'control' ? '中控' : '运营'} · 主播 {s.anchor.name}{s.control ? `，中控 ${s.control.name}` : ''} · {s.douyinAccount.name}{s.note ? ` · ${s.note}` : ''}</small></div>
                <SchedulePill status={s.status} label={s.statusLabel} />
                {s.status === 'scheduled' && s.mineRole !== 'operator' && <button type="button" className="primary-button" disabled={!s.canStart} title={s.canStart ? '' : '开始前 2 小时起可以上播'} onClick={() => setStarting({ schedule: s })}>上播</button>}
              </li>
            ))}</ul>
          </section>
          <section className="card live-section" aria-label="最近场次">
            <h2>最近 20 场</h2>
            {d.recent.length === 0 && <p className="muted pad">还没有直播记录。</p>}
            <ul className="live-list">{d.recent.map((s) => (
              <li key={s.id}>
                <div className="main"><strong>{s.date} {hm(s.startAt)}–{hm(s.endAt, s.date)} · {s.roomName}</strong><small>{s.finalSalesCents !== null ? `销售额 ${money(s.finalSalesCents)}` : '待审核'}</small></div>
                <SessionPill status={s.status} label={s.statusLabel} />
                <button type="button" className="secondary-button small" onClick={() => setOpenId(s.id)}>详情</button>
              </li>
            ))}</ul>
          </section>
        </>
      )}
      {starting && d && <StartDialog schedule={starting.schedule} identity={d.identity} onClose={() => setStarting(null)} onDone={(id) => { setStarting(null); load(); setOpenId(id); }} />}
      {openId !== null && <SessionDetailDialog id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}
