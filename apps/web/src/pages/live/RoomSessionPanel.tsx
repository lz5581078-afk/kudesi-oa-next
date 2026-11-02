import { useCallback, useEffect, useRef, useState } from 'react';
import { LIVE_PLATFORMS } from '@kudesi/shared';
import { liveApi, type RoomCurrentSession, type SessionTurnover } from './liveApi';
import { errText, hm, money } from './liveFormat';
import { Modal } from './liveUi';
import { productText } from './liveProducts';

export function RoomSessionPanel({ session, day, now }: { session: RoomCurrentSession | null; day: string; now: string }) {
  const [data, setData] = useState<SessionTurnover | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const request = useRef(0);
  const id = session?.id;
  const end = session?.endAt;
  const load = useCallback(() => {
    if (!id) return;
    const token = ++request.current;
    setBusy(true);
    liveApi.turnover(id).then(d => { if (token === request.current) { setData(d); setError(''); } })
      .catch(e => { if (token === request.current) setError(errText(e, '读取本场营业额失败')); })
      .finally(() => { if (token === request.current) setBusy(false); });
  }, [id, end]);
  useEffect(() => {
    setData(null); setError(''); setOpen(false); load();
    const refresh = () => { if (document.visibilityState === 'visible') load(); };
    const timer = id ? setInterval(refresh, 30_000) : null;
    document.addEventListener('visibilitychange', refresh);
    return () => { request.current++; if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [load, id]);
  const done = !!session?.endAt;
  const elapsed = session ? Math.max(0, Math.floor((Date.parse((session.endAt || now).replace(' ', 'T') + '+08:00') - Date.parse(session.startAt.replace(' ', 'T') + '+08:00')) / 60000)) : 0;
  const duration = session?.plannedEnd ? Math.max(1,(Date.parse(session.plannedEnd.replace(' ', 'T') + '+08:00') - Date.parse(session.startAt.replace(' ', 'T') + '+08:00'))/60000) : null;
  const progress = duration ? Math.min(100, Math.round(elapsed/duration*100)) : null;
  const available = !!data?.available && !error;
  return <section className="live-current" aria-label="本场直播">
    {done && <div className="live-current-head"><span>最近一场</span><small>已下播</small></div>}
    <div className="live-current-people">{[['主播',session?.anchor.name],['中控',session?.control?.name],['运营',session?.operator?.name]].map(([label,name]) => <span key={label}>{label}<strong title={name || '未安排'}>{name || '—'}</strong></span>)}</div>
    <button type="button" className="live-turnover-button" disabled={!session} onClick={() => setOpen(true)} aria-label="查看本场营业额">
      <span>本场营业额</span><strong>{!session ? '—' : error ? '读取失败' : !data ? '读取中…' : available ? money(data.turnoverCents!) : '暂不可用'}</strong><small>{session ? available ? `${data!.orderCount} 单 · 查看店铺 ›` : '查看原因 ›' : '报上播后开始统计'}</small>
    </button>
    <div className="live-current-times"><span>开播<strong>{hm(session?.startAt,day)}</strong></span><span>{done ? '下播' : '预计下播'}<strong>{hm(session?.endAt || session?.plannedEnd,day)}</strong></span><span>已播<strong>{session ? (elapsed < 60 ? `${elapsed} 分` : `${Math.floor(elapsed / 60)}时${elapsed % 60}分`) : '—'}</strong></span></div>
    {session && <>
      {!done && <div className="live-progress-track" role="progressbar" aria-label="本场直播进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}><i style={{width:`${progress ?? 0}%`}} /></div>}
      <small className="live-current-note">{error ? '营业额查询失败，点击查看' : data ? `更新于 ${hm(data.queriedAt,day)}` : '正在读取聚水潭'}{!done && progress !== null ? duration && elapsed > duration ? ' · 已超预计下播' : ` · 进度 ${progress}%` : ''}</small>
      <small className="live-current-products" title={productText(session.products)}>本场产品 {productText(session.products)}</small>
    </>}
    {open && session && <Modal title={`${data?.roomName || ''} · 本场营业额`} onClose={() => setOpen(false)} foot={<button type="button" className="secondary-button" disabled={busy} onClick={load}>{busy ? '刷新中…' : '刷新营业额'}</button>}>
      <p className="muted">统计成单时间：{data?.startAt || session.startAt} 至 {data?.endAt || session.endAt || now}{!done ? '（直播中）' : ''}。只计算本场时间内成单且仍有效的订单；历史订单在此期间退款不计入。</p>
      {(error || (data && !data.available)) && <p className="notice error" role="alert">{error || data?.reason}，不会按零元计算。</p>}
      {!data && !error && <p role="status">正在读取聚水潭订单…</p>}
      {data && <><div className="live-scroll"><table className="data-table live-turnover-table"><thead><tr><th>店铺 / 平台</th><th>有效单数</th><th>有效营业额</th><th>本场订单退款</th></tr></thead><tbody>{data.stores.map(s => <tr key={s.storeId}><td>{s.storeName}<small>{LIVE_PLATFORMS[s.platform] || s.platform}</small>{!s.available && <small className="error-text">{s.reason}</small>}</td><td data-label="有效单数">{s.available ? `${s.orderCount} 单` : '—'}</td><td data-label="有效营业额">{s.available ? money(s.turnoverCents!) : '—'}</td><td data-label="本场订单退款">{s.available ? money(s.refundCents!) : '—'}</td></tr>)}</tbody><tfoot><tr><th>合计</th><td data-label="有效单数">{data.available ? `${data.orderCount} 单` : '—'}</td><td data-label="有效营业额">{data.available ? money(data.turnoverCents!) : '暂不可用'}</td><td data-label="本场订单退款">{data.available ? money(data.refundCents!) : '—'}</td></tr></tfoot></table></div>
        <p className="muted">数据来自聚水潭。有效营业额＝本场实付金额－本场订单已确认退款，全额退款不计有效单数。更新于 {data.queriedAt}，约每 30 秒刷新。</p></>}
    </Modal>}
  </section>;
}
