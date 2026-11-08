import { PersonPhotoName } from './PersonPhotoName';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LIVE_PLATFORMS } from '@kudesi/shared';
import { liveApi, type RoomCurrentSession, type SessionTurnover } from './liveApi';
import { durationSuffix, errText, hm, money } from './liveFormat';
import { Modal } from './liveUi';
import { productText } from './liveProducts';

export function RoomSessionAccounts({session}:{session:RoomCurrentSession|null}) {
  if(!session)return <div className="live-room-accounts empty" aria-hidden="true"/>;
  const accounts=session.accounts?.length?session.accounts:[session.douyinAccount];
  const names=accounts.map(a=>a.name).filter(Boolean).join(' / ')||'未记录';
  return <div className="live-room-accounts" aria-label={`本场实际直播号：${names}`}><small>{session.endAt?'上场直播号':'直播号'}</small><strong title={names}>{names}</strong></div>;
}

export function RoomSessionPanel({ session, day, now }: { session: RoomCurrentSession | null; day: string; now: string }) {
  const [data, setData] = useState<SessionTurnover | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const request = useRef(0);
  const locked = useRef(false);
  const previousId = useRef<number | undefined>(undefined);
  const id = session?.id;
  const end = session?.endAt;
  const load = useCallback(() => {
    if (!id) return;
    const token = ++request.current;
    return liveApi.turnover(id).then(d => { if (token === request.current) { setData(d); locked.current = !!d.locked; setError(''); } })
      .catch(e => { if (token === request.current) setError(errText(e, '读取本场营业额失败')); });
  }, [id, end]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 只读取服务器共享快照；慢请求不叠加，最终快照锁定后停止轮询。
    const schedule = () => {
      if (active && id && !end && !locked.current) timer = setTimeout(async () => {
        if (document.visibilityState === 'visible') await load();
        schedule();
      }, 60_000);
    };
    if (previousId.current !== id) { setData(null); previousId.current = id; }
    setError(''); setOpen(false); locked.current = !!end;
    if (!end) void Promise.resolve(load()).then(schedule);
    const refresh = () => { if (!end && document.visibilityState === 'visible' && !locked.current) load(); };
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; request.current++; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [load, id, end]);
  const done = !!session?.endAt;
  const orderStart = data?.startAt || session?.startAt;
  const orderEnd = data?.endAt || session?.endAt || now;
  const elapsed = session ? Math.max(0, Math.floor((Date.parse((session.endAt || now).replace(' ', 'T') + '+08:00') - Date.parse(session.startAt.replace(' ', 'T') + '+08:00')) / 60000)) : 0;
  const duration = session?.plannedEnd ? Math.max(1,(Date.parse(session.plannedEnd.replace(' ', 'T') + '+08:00') - Date.parse(session.startAt.replace(' ', 'T') + '+08:00'))/60000) : null;
  const progress = duration ? Math.min(100, Math.round(elapsed/duration*100)) : null;
  const available = !!data?.available && !error;
  return <section className="live-current" aria-label="本场直播">
    {done && <div className="live-current-head"><span>最近一场</span><small>已下播</small></div>}
    <div className="live-current-people">{(['anchor','control','operator'] as const).map(role => {
      const label={anchor:'主播',control:'中控',operator:'运营'}[role],person=session?.[role],reported=session?.startReports?.[role];
      const status=reported===true?'已报上播':reported===false?'未报上播':'未记录';
      return <span className="live-current-person" key={role}><small className="live-person-role">{label}</small><span className="live-person-identity"><strong title={person?.name || '未安排'}>{person&&role==='anchor'?<PersonPhotoName key={person.id} personId={person.id} name={person.name}/>:person?.name || '—'}</strong>{person&&<small className={`live-start-report ${reported===true?'reported':reported===false?'unreported':'unknown'}`} title={`${person.name}：${status}${reported==null?'（历史场次未记录个人上播状态）':''}`} aria-label={`${person.name}：${status}`}>{reported===true?'已报':reported===false?'未报':'未记录'}</small>}</span></span>;
    })}</div>
    <button type="button" className="live-turnover-button" disabled={!session} onClick={() => { setOpen(true); if (done && !data) void load(); }} aria-label="查看本场营业额">
      <span>本场营业额</span><strong>{!session ? '—' : error ? '读取失败' : !data ? done ? '已下播' : '读取中…' : available ? money(data.turnoverCents!) : '暂不可用'}</strong><small>{session ? available ? `${data!.orderCount} 单 · 查看店铺 ›` : done ? '查看已存数据 ›' : '查看原因 ›' : '报上播后开始统计'}</small>
    </button>
    <div className="live-current-times"><span>开播<strong>{hm(session?.startAt,day)}</strong></span><span>{done ? '下播' : '预计下播'}<strong>{hm(session?.endAt || session?.plannedEnd,day)}</strong></span><span>已播<strong>{session ? (elapsed < 60 ? `${elapsed} 分` : `${Math.floor(elapsed / 60)}时${elapsed % 60}分`) : '—'}</strong></span></div>
    {session && <>
      {!done && <div className="live-progress-track" role="progressbar" aria-label="本场直播进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}><i style={{width:`${progress ?? 0}%`}} /></div>}
      <small className="live-current-note">{done ? '下播已停止销售查询' : error ? '营业额读取失败，稍后自动重试' : data?.locked ? '本场营业额已锁定' : data?.refreshError ? '服务器正在重试更新' : '营业额由服务器统一更新'}{!done && progress !== null ? duration && elapsed > duration ? ' · 已超预计下播' : ` · 进度 ${progress}%` : ''}</small>
      <small className="live-current-products" title={productText(session.products)}>本场产品 {productText(session.products)}</small>
    </>}
    {open && session && <Modal title={`${data?.roomName || ''} · 本场营业额`} onClose={() => setOpen(false)}>
      <p className="muted">统计成单时间：{orderStart} 至 {orderEnd}{durationSuffix(orderStart, orderEnd)}{!done ? '（直播中）' : ''}。只计算本场时间内成单且仍有效的订单；历史订单在此期间退款不计入。</p>
      {(error || (data && !data.available)) && <p className="notice error" role="alert">{error || data?.reason}，不会按零元计算。</p>}
      {!data && !error && <p role="status">正在读取聚水潭订单…</p>}
      {data && <><div className="live-scroll"><table className="data-table live-turnover-table"><thead><tr><th>店铺 / 平台</th><th>有效单数</th><th>有效营业额</th><th>本场订单退款</th></tr></thead><tbody>{data.stores.map(s => <tr key={s.storeId}><td>{s.storeName}<small>{LIVE_PLATFORMS[s.platform] || s.platform}</small>{!s.available && <small className="error-text">{s.reason}</small>}</td><td data-label="有效单数">{s.available ? `${s.orderCount} 单` : '—'}</td><td data-label="有效营业额">{s.available ? money(s.turnoverCents!) : '—'}</td><td data-label="本场订单退款">{s.available ? money(s.refundCents!) : '—'}</td></tr>)}</tbody><tfoot><tr><th>合计</th><td data-label="有效单数">{data.available ? `${data.orderCount} 单` : '—'}</td><td data-label="有效营业额">{data.available ? money(data.turnoverCents!) : '暂不可用'}</td><td data-label="本场订单退款">{data.available ? money(data.refundCents!) : '—'}</td></tr></tfoot></table></div>
        <p className="muted">数据来自聚水潭。有效营业额＝本场实付金额－本场订单已确认退款，全额退款不计有效单数。仅在直播中自动更新；下播后只展示已保存数据，所有人查看同一份营业额。</p></>}
    </Modal>}
  </section>;
}
