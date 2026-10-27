import { useCallback, useEffect, useState } from 'react';
import { LIVE_SESSION_STATUS } from '@kudesi/shared';
import { Pager } from '../finance/common';
import { downloadText, toCsv } from '../../resources/csv';
import { liveApi, type Options, type SessionList } from './liveApi';
import { errText, hm, money, yuanText } from './liveFormat';
import { SessionPill, names } from './liveUi';

const PAGE = 20;
const KEY = 'kudesi.live.sessionFilters';
type Filters = { from: string; to: string; roomId: string; anchorId: string; controlId: string; status: string };
const EMPTY: Filters = { from: '', to: '', roomId: '', anchorId: '', controlId: '', status: '' };
const remember = (): Filters => { try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return EMPTY; } };

/** 场次记录（带筛选，记住本机筛选）；预设状态时用作「待审核」列表。 */
export function SessionsTab({ presetStatus, onOpen, refreshKey = 0 }: { presetStatus?: string; onOpen: (id: number) => void; refreshKey?: number }) {
  const [f, setF] = useState<Filters>(() => (presetStatus ? EMPTY : remember()));
  const [page, setPage] = useState(1);
  const [d, setD] = useState<SessionList | null>(null);
  const [opts, setOpts] = useState<Options | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { liveApi.options().then(setOpts).catch(() => setOpts(null)); }, []);
  const load = useCallback(() => {
    const status = presetStatus ?? f.status;
    liveApi.sessions({ from: f.from, to: f.to, roomId: f.roomId, anchorId: f.anchorId, controlId: f.controlId, status, page, pageSize: PAGE }).then((x) => { setD(x); setError(''); }).catch((e) => setError(errText(e, '读取失败')));
  }, [f, page, presetStatus]);
  useEffect(load, [load, refreshKey]);
  /** 按当前筛选导出全部场次（每次取 100 条，最多 2000 条） */
  async function exportAll() {
    try {
      const rows: string[][] = [['日期', '直播间', '上播', '下播', '主播', '中控', '运营', '抖音号', '状态', '最终销售额', '场次编号']];
      for (let p = 1; p <= 20; p += 1) {
        const r = await liveApi.sessions({ from: f.from, to: f.to, roomId: f.roomId, anchorId: f.anchorId, controlId: f.controlId, status: presetStatus ?? f.status, page: p, pageSize: 100 });
        for (const s of r.rows) rows.push([s.date, s.roomName, s.startAt, s.endAt ?? '', s.anchor.name, s.control?.name ?? '', s.operator?.name ?? '', s.douyinAccount.name, s.statusLabel, yuanText(s.finalSalesCents), String(s.id)]);
        if (p * 100 >= r.total) break;
      }
      downloadText('直播场次.csv', toCsv(rows));
    } catch (e) { setError(errText(e, '导出失败')); }
  }
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => {
    const next = { ...f, [k]: e.target.value };
    setF(next); setPage(1);
    if (!presetStatus) { try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 本机存不了就不记 */ } }
  };
  return (
    <section className="card live-section" aria-label={presetStatus ? '待审核场次' : '场次记录'}>
      <div className="live-filter">
        <label className="live-field">从<input aria-label="场次开始日期" type="date" value={f.from} onChange={set('from')} /></label>
        <label className="live-field">到<input aria-label="场次结束日期" type="date" value={f.to} onChange={set('to')} /></label>
        <label className="live-field">直播间<select aria-label="场次直播间" value={f.roomId} onChange={set('roomId')}><option value="">全部</option>{opts?.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label className="live-field">主播<select aria-label="场次主播" value={f.anchorId} onChange={set('anchorId')}><option value="">全部</option>{opts?.anchors.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="live-field">中控<select aria-label="场次中控" value={f.controlId} onChange={set('controlId')}><option value="">全部</option>{opts?.controls.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {!presetStatus && <label className="live-field">状态<select aria-label="场次状态" value={f.status} onChange={set('status')}><option value="">全部</option>{Object.entries(LIVE_SESSION_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
        <button type="button" className="secondary-button" onClick={load}>刷新</button>
        <button type="button" className="secondary-button" onClick={() => void exportAll()}>导出 CSV</button>
      </div>
      {error && <div role="alert" className="notice error m">{error}</div>}
      {d && d.rows.length === 0 && <p className="muted pad" role="status">{presetStatus ? '目前没有待审核的场次。' : '没有符合条件的场次。'}</p>}
      <ul className="live-list">{d?.rows.map((s) => (
        <li key={s.id}>
          <div className="main"><strong>{s.date} {hm(s.startAt)}–{s.endAt ? hm(s.endAt, s.date) : '直播中'} · {s.roomName}</strong><small>{names(s.anchor, s.control, s.operator)} · {s.douyinAccount.name}{s.finalSalesCents !== null ? ` · 最终销售额 ${money(s.finalSalesCents)}` : ''}{s.returnReason ? ` · 退回：${s.returnReason}` : ''}</small></div>
          <SessionPill status={s.status} label={s.statusLabel} />
          <button type="button" className="secondary-button small" onClick={() => onOpen(s.id)}>{presetStatus ? '去审核' : '详情'}</button>
        </li>
      ))}</ul>
      {d && d.total > PAGE && <div className="pad"><Pager page={page} total={d.total} pageSize={PAGE} onPage={setPage} /></div>}
    </section>
  );
}
