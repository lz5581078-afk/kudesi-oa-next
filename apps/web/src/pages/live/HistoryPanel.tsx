import { useCallback, useEffect, useState } from 'react';
import { Pager } from '../finance/common';
import { liveApi, type History, type Period } from './liveApi';
import { errText, hm, minutesText, money, todayText } from './liveFormat';
import { SessionPill } from './liveUi';

const PAGE = 20;
const Sum = ({ title, p }: { title: string; p: Period }) => (
  <div className="card live-stat" aria-label={title}>
    <span>{title}</span><strong>{p.sessions} 场 · {minutesText(p.minutes)}</strong>
    <small className="muted">提成 {money(p.commissionCents)} · 工资 {money(p.wageCents)}（{minutesText(p.wageMinutes)}）</small>
  </div>
);

/** 我的场次历史：按月 / 起止日期 / 全部，分页；累计、本月、上月汇总。 */
export function HistoryPanel({ onOpen }: { onOpen: (id: number) => void }) {
  const [mode, setMode] = useState<'month' | 'range' | 'all'>('month');
  const [month, setMonth] = useState(todayText().slice(0, 7));
  const [from, setFrom] = useState(`${todayText().slice(0, 7)}-01`);
  const [to, setTo] = useState(todayText());
  const [page, setPage] = useState(1);
  const [d, setD] = useState<History | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    liveApi.history({ mode, month: mode === 'month' ? month : undefined, from: mode === 'range' ? from : undefined, to: mode === 'range' ? to : undefined, page, pageSize: PAGE })
      .then((x) => { setD(x); setError(''); }).catch((e) => setError(errText(e, '读取失败')));
  }, [mode, month, from, to, page]);
  useEffect(load, [load]);
  return (
    <div className="live-page">
      {d && <div className="live-cards"><Sum title="累计" p={d.summary.all} /><Sum title="本月" p={d.summary.thisMonth} /><Sum title="上月" p={d.summary.lastMonth} /></div>}
      <section className="card live-section">
        <div className="live-filter">
          <label className="live-field">范围<select aria-label="历史范围" value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setPage(1); }}><option value="month">按月</option><option value="range">起止日期</option><option value="all">全部</option></select></label>
          {mode === 'month' && <label className="live-field">月份<input aria-label="历史月份" type="month" value={month} onChange={(e) => { setMonth(e.target.value); setPage(1); }} /></label>}
          {mode === 'range' && <><label className="live-field">从<input aria-label="开始日期" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></label><label className="live-field">到<input aria-label="结束日期" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></label></>}
        </div>
        {error && <div role="alert" className="notice error m">{error}</div>}
        {d && d.rows.length === 0 && <p className="muted pad">这个范围内没有直播场次。</p>}
        <ul className="live-list">
          {d?.rows.map((r) => (
            <li key={r.id}>
              <div className="main"><strong>{r.date} {hm(r.startAt)}–{hm(r.endAt, r.date)} · {r.roomName}</strong><small>{r.myRoles.join('、')} · {r.douyinAccount.name}{r.finalSalesCents !== null ? ` · 销售额 ${money(r.finalSalesCents)}` : ''}</small></div>
              <span>{r.commissionCents !== null ? `提成 ${money(r.commissionCents)}` : ''}{r.wageCents !== null ? ` 工资 ${money(r.wageCents)}` : ''}</span>
              <SessionPill status={r.status} label={r.statusLabel} />
              <button type="button" className="secondary-button small" onClick={() => onOpen(r.id)}>详情</button>
            </li>
          ))}
        </ul>
        {d && d.total > PAGE && <div className="pad"><Pager page={page} total={d.total} pageSize={PAGE} onPage={setPage} /></div>}
      </section>
    </div>
  );
}
