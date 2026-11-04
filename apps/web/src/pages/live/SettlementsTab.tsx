import { PersonPhotoName } from './PersonPhotoName';
import { LIVE_PLATFORMS } from '@kudesi/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { downloadText, toCsv } from '../../resources/csv';
import { liveApi, type SettlementDetail, type SettlementHead } from './liveApi';
import { errText, money, ratePct, yuanText } from './liveFormat';
import { SettlementActions } from './SettlementActions';
import { Modal } from './liveUi';

const TONE: Record<string, string> = { draft: '', submitted: 'warn', returned: 'bad', approved: 'ok', voided:'bad' };

function DetailDialog({ id, canManage, onClose, onChanged, onOpenSession }: { id: number; canManage: boolean; onClose: () => void; onChanged: () => void; onOpenSession: (sessionId: number) => void }) {
  const [d, setD] = useState<SettlementDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { liveApi.settlement(id).then((x) => { setD(x); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, [id]);
  useEffect(load, [load]);
  async function act(kind: 'recheck' | 'submit') {
    if (!d) return;
    setBusy(true); setError('');
    try { if (kind === 'recheck') await liveApi.generateSettlement(d.month, d.note || undefined,{...(d.from&&d.to?{from:d.from,to:d.to}:{}),...(!d.legacy&&d.kind?{kind:d.kind==='adjustment'?'mixed':d.kind,userIds:d.userIds??[],settlementId:d.id}:{})}); else await liveApi.submitSettlement(d.id,d.revision); load(); onChanged(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  const editable = canManage && d && (d.status === 'draft' || d.status === 'returned');
  return (
    <Modal title={d ? `${d.from??d.month} 至 ${d.to??d.month} ${d.kind==='commission'?'提成结算':d.kind==='adjustment'?'补扣款调整':'工资结算'}` : '直播工资结算'} size="wide" onClose={onClose} foot={d && <>
      <button type="button" className="secondary-button" onClick={() => downloadText(`直播工资结算-${d.from??d.month}-${d.to??''}.csv`, toCsv([['日期', '平台', '直播间', '人员', '角色', '最终销售额', '比例', '时间工资', '计薪分钟', '时薪', '原提成', '订单数', '退款', '扣减', '应发', '场次编号','填报来源','特殊原因','未核对店铺及原因'], ...d.lines.map((l) => [l.date,LIVE_PLATFORMS[l.platform??'']??'历史场次', l.roomName, l.userName, l.roleLabel, yuanText(l.finalSalesCents), ratePct(l.rateUnits), yuanText(l.wageCents??0),String(l.minutes??0),yuanText(l.hourlyRateCents??0),yuanText(l.commissionCents), String(l.orderCount), yuanText(l.refundCents), yuanText(l.deductionCents), yuanText(l.payableCents), String(l.sessionId),l.source==='manual'?'人事手工':'本人填报',l.manualReason??'',(l.unverifiedStores??[]).map(s=>`${s.name}：${s.reason}`).join('；')])]))}>导出工资报表</button>
      <button className="secondary-button" onClick={()=>downloadText(`订单售后核对-${d.id}.csv`,toCsv([['场次','平台','聚水潭店铺编号','订单号','订单金额','退款金额','核对状态','售后依据','核对时间'],...d.refunds.map(r=>[String(r.sessionId),LIVE_PLATFORMS[r.platform??'']??'',r.shopId??'',r.orderId,yuanText(r.orderAmountCents),yuanText(r.refundCents),r.source==='none'?'无已完成退款':r.source==='cancelled'?'订单已取消':'已完成退款',JSON.stringify(r.details),r.checkedAt])]))}>导出订单售后报表</button>
      {editable && !d.originalSettlementId && <button type="button" className="secondary-button" disabled={busy} onClick={() => void act('recheck')}>重新核对明细</button>}
      {editable && <button type="button" className="primary-button" disabled={busy} onClick={() => void act('submit')}>{d.status === 'returned' ? '重新提交审批' : '提交审批'}</button>}
    </>}>
      {error && <div role="alert" className="notice error">{error}</div>}
      {!d && !error && <p className="muted" role="status">正在读取…</p>}
      {d && (
        <>
          <div className="live-cards"><div className="card live-stat"><span>时间工资合计</span><strong>{money(d.wageTotalCents??0)}</strong></div>
            <div className="card live-stat"><span>原提成合计</span><strong>{money(d.commissionTotalCents)}</strong></div>
            <div className="card live-stat"><span>退款合计</span><strong>{money(d.refundTotalCents)}</strong></div>
            <div className="card live-stat"><span>扣减合计</span><strong>{money(d.deductionTotalCents)}</strong></div>
            <div className="card live-stat"><span>应发合计</span><strong>{money(d.payableTotalCents)}</strong></div>
          </div>
          <p className="muted"><span className={`pill ${TONE[d.status]}`}>{d.statusLabel}</span> 共 {d.recordCount} 条工资提成{d.kind!=='wage'&&d.kind!=='adjustment'&&<> · 售后核对于 {d.refundsCheckedAt ?? '—'}（聚水潭只读）</>}{d.flowRunId ? <> · <Link to="/flow/overview">查看审批流程</Link></> : ''}</p>
          {d.status === 'returned' && d.returnReason && <div className="notice warn">已退回：{d.returnReason}。请重新核对后再提交。</div>}
          <p className="muted">{d.originalSettlementId?`关联原结算单 #${d.originalSettlementId} · `:''}结算单 #{d.id} · {d.kind==='wage'?'工资':d.kind==='commission'?'提成':d.kind==='adjustment'?'补扣款调整':'工资及提成'} · 创建人 {d.creatorName} · 确认时间 {d.approvedAt??'待审批'} · 已付 {money(d.paidTotalCents??0)} · 未付 {money(d.payableTotalCents-(d.paidTotalCents??0))}</p>
          {d.voidReason&&<p className="notice warn">作废原因：{d.voidReason}</p>}
          {!!d.adjustments?.length&&<div className="notice warn">关联调整单：{d.adjustments.map(a=><span key={a.id}> #{a.id} · {money(Number(a.amountCents))} · {{draft:'草稿',submitted:'审批中',returned:'退回',approved:'已确认',voided:'作废'}[a.status]??a.status} · {a.note}；</span>)}</div>}
          <SettlementActions detail={d} canManage={canManage} onChanged={()=>{load();onChanged();}}/>
          {!!d.excluded?.length&&<details><summary>未纳入本单的明细（{d.excluded.length}）</summary><ul>{d.excluded.map((e,i)=><li key={i}>{e.date} · 人员 #{e.userId} · {e.sessionId?`场次 #${e.sessionId}`:'日常工作'} · {e.kind==='wage'?'工资':'提成'}：{e.reason}</li>)}</ul></details>}
          <strong>按人员</strong>
          <div className="live-scroll"><table className="data-table" aria-label="按人员汇总"><thead><tr><th>人员</th><th>角色</th><th className="num">场次</th><th className="num">时间工资</th><th className="num">原提成</th><th className="num">扣减</th><th className="num">应发</th></tr></thead>
            <tbody>{d.byPerson.map((p) => <tr key={`${p.userId}${p.role}`}><td>{p.role==='anchor'?<PersonPhotoName personId={p.userId} name={p.name}/>:p.name}</td><td>{p.roleLabel}</td><td className="num">{p.sessions}</td><td className="num">{money(p.wageCents??0)}</td><td className="num">{money(p.commissionCents)}</td><td className="num">{money(p.deductionCents)}</td><td className="num">{money(p.payableCents)}</td></tr>)}</tbody></table></div>
          <strong>明细（点场次查看）</strong>
          <div className="live-scroll"><table className="data-table" aria-label="结算明细"><thead><tr><th>日期</th><th>直播间</th><th>人员</th><th>角色</th><th className="num">比例</th><th className="num">时间工资</th><th className="num">原提成</th><th className="num">退款</th><th className="num">扣减</th><th className="num">应发</th><th /></tr></thead>
            <tbody>{d.lines.map((l) => <tr key={l.id}><td>{l.date}</td><td>{l.roomName}<small> · {l.dailyWorkId?'日常工作':LIVE_PLATFORMS[l.platform??'']??'历史场次'}</small></td><td>{l.role==='anchor'?<PersonPhotoName personId={l.userId} name={l.userName}/>:l.userName}</td><td>{l.roleLabel}</td><td className="num">{ratePct(l.rateUnits)}</td><td className="num">{money(l.wageCents??0)}<small> · {l.minutes??0} 分</small></td><td className="num">{money(l.commissionCents)}</td><td className="num">{money(l.refundCents)}</td><td className="num">{money(l.deductionCents)}</td><td className="num">{money(l.payableCents)}</td><td><button type="button" className="link-button" disabled={!!l.dailyWorkId} onClick={() => onOpenSession(l.sessionId)}>{l.dailyWorkId?'日常工作':'场次'}</button></td></tr>)}</tbody></table></div>
          {d.lines.some(l=>l.unverifiedStores?.length)&&<div className="notice warn"><strong>特殊核定，未核对订单</strong><ul>{d.lines.filter((l,i,all)=>l.unverifiedStores?.length&&all.findIndex(x=>x.sessionId===l.sessionId&&x.platform===l.platform)===i).map(l=><li key={`${l.sessionId}:${l.platform}`}>场次 #{l.sessionId} · {LIVE_PLATFORMS[l.platform??'']}：{l.unverifiedStores!.map(s=>`${s.name}：${s.reason}`).join('；')}</li>)}</ul></div>}
          {d.lines.some(l=>l.source==='manual'&&!l.orderCount)&&<div className="notice warn"><strong>特殊核定，未核对订单</strong><ul>{d.lines.filter((l,i,all)=>l.source==='manual'&&!l.orderCount&&all.findIndex(x=>x.sessionId===l.sessionId)===i).map(l=><li key={l.sessionId}>场次 #{l.sessionId}：{l.manualReason}（按人工审核金额核算）</li>)}</ul></div>}
          {!!d.events?.length&&<details><summary>结算及付款操作记录</summary><ul>{d.events.map(e=><li key={e.id}>{e.at} · {e.actor_name} · {{recheck:'生成/重新核对',submitted:'提交审批',approved:'确认结算',payment:'登记付款/追回',voided:'作废',adjustment:'新增补扣款调整'}[e.event_type]??e.event_type}{Number(e.amount_cents)?` · ${money(Number(e.amount_cents))}`:''}<span> · {Object.entries((typeof e.detail_json==='string'?JSON.parse(e.detail_json):e.detail_json) as Record<string,unknown>).filter(([key])=>['reason','reference','note'].includes(key)).map(([,value])=>String(value)).join(' · ')}</span></li>)}</ul></details>}
          <strong>订单与售后核对依据（共 {d.refunds.length} 单）</strong>
          {d.refunds.length === 0 ? <p className="muted">{d.kind==='wage'?'工资本身无需核对订单退款。':d.kind==='adjustment'?'调整依据见关联原单和业务凭证。':'本期没有可核对的订单；请检查特殊核定说明。'}</p> : (
            <div className="live-scroll"><table className="data-table" aria-label="退款依据"><thead><tr><th>场次</th><th>订单号</th><th className="num">订单金额</th><th className="num">退款</th><th>售后状态与依据</th><th>核对时间</th></tr></thead>
              <tbody>{d.refunds.map((r) => <tr key={`${r.sessionId}:${r.shopId}:${r.orderId}`}><td>#{r.sessionId}</td><td>{LIVE_PLATFORMS[r.platform??'']??''} · {r.shopId} · {r.orderId}</td><td className="num">{money(r.orderAmountCents)}</td><td className="num">{money(r.refundCents)}</td><td>{r.source === 'cancelled' ? '订单已取消' : r.source==='none'?'无已完成退款':'已完成的售后单'}<details><summary>售后明细</summary><pre>{JSON.stringify(r.details,null,2)}</pre></details></td><td>{r.checkedAt}</td></tr>)}</tbody></table></div>
          )}
        </>
      )}
    </Modal>
  );
}

/** 工资、提成按人员与期间独立结算；草稿、审批和付款分别留痕。 */
export function SettlementsTab({ onOpenSession }: { onOpenSession: (id: number) => void }) {
  const [d, setD] = useState<{ canManage: boolean; defaultMonth: string; people?:Array<{id:number;name:string}>; rows: SettlementHead[] } | null>(null);
  const [month, setMonth] = useState('');
  const [mode,setMode]=useState('month'),[from,setFrom]=useState(''),[to,setTo]=useState('');
  const [kind,setKind]=useState<'wage'|'commission'>('wage');
  const [userIds,setUserIds]=useState<number[]>([]);
  const [preview,setPreview]=useState<Awaited<ReturnType<typeof liveApi.previewSettlement>>|null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback(() => { liveApi.settlements().then((x) => { setD(x); setMonth((m) => m || x.defaultMonth); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, []);
  useEffect(load, [load]);
  const previewSeq=useRef(0);
  useEffect(()=>{previewSeq.current++;setPreview(null);},[kind,userIds,mode,month,from,to]);
  async function checkScope(){const seq=++previewSeq.current;setBusy(true);setError('');try{const result=await liveApi.previewSettlement({kind,userIds,month,...(mode==='range'?{from,to}:{})});if(seq===previewSeq.current)setPreview(result);}catch(e){setError(errText(e));}finally{setBusy(false);}}
  async function generate() {
    setBusy(true); setError('');
    try { const r = await liveApi.generateSettlement(month, note.trim() || undefined,{kind,userIds,...(mode==='range'?{from,to}:{})}); load(); setOpen(r.id); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  return (
    <div className="live-page">
      {d?.canManage && (
        <section className="card live-section" aria-label="生成结算单">
          <div className="live-filter">
            <label className="live-field">结算类型<select aria-label="结算类型" value={kind} onChange={e=>setKind(e.target.value as 'wage'|'commission')}><option value="wage">工资</option><option value="commission">提成</option></select></label>
            <label className="live-field">结算人员（可多选，留空为全部）<select aria-label="结算人员" multiple value={userIds.map(String)} onChange={e=>setUserIds(Array.from(e.target.selectedOptions,o=>Number(o.value)))}>{d.people?.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="live-field">结算方式<select aria-label="结算方式" value={mode} onChange={e=>setMode(e.target.value)}><option value="month">按月结算</option><option value="range">按日期范围结算</option></select></label>
            {mode==='month'?<label className="live-field">结算月份<input aria-label="结算月份" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>:<><label className="live-field">开始日期<input aria-label="结算开始日期" type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label className="live-field">结束日期<input aria-label="结算结束日期" type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></>}
            <label className="live-field">备注（可选）<input aria-label="结算备注" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <button type="button" className="secondary-button" disabled={busy||(mode==='month'?!month:!from||!to)} onClick={()=>void checkScope()}>预览可结算范围</button>
            <button type="button" className="primary-button" disabled={busy || (mode==='month'?!month:!from||!to)} onClick={() => void generate()}>{busy ? '核对退款中…' : '生成 / 重新核对'}</button>
          </div>
          {preview&&<div className="pad" aria-label="范围预览"><p>可结算 {preview.lines.length} 条 · 工资及原提成 {money(preview.lines.reduce((n,l)=>n+l.amountCents,0))}。提成实际应发以生成草稿时核对退款后的金额为准。</p><ul>{preview.lines.map((l,i)=><li key={i}>{l.date} · {d.people?.find(p=>p.id===l.userId)?.name??`人员 #${l.userId}`} · {l.sessionId?`场次 #${l.sessionId}`:'日常工作'} · {l.kind==='wage'?'工资':'提成'} · {money(l.amountCents)}</li>)}</ul><details open={!preview.lines.length}><summary>未纳入 {preview.excluded.length} 条</summary><ul>{preview.excluded.map((l,i)=><li key={i}>{l.date} · {d.people?.find(p=>p.id===l.userId)?.name??`人员 #${l.userId}`} · {l.reason}</li>)}</ul></details></div>}
          <p className="muted pad">工资、提成分别结算；提成最早在所属月份的次月10日（含当天，北京时间）结算，往月未结可补结。只纳入已审核、尚未被其他结算单占用的明细，未纳入原因在详情列出。生成仅为草稿，审批确认与实际付款分别记录。日期范围含起止日。</p>
        </section>
      )}
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      <section className="card live-section" aria-label="历史结算">
        <h2>历史结算</h2>
        {d && d.rows.length === 0 && <p className="muted pad" role="status">还没有生成过结算单。</p>}
        <ul className="live-list">{d?.rows.map((r) => (
          <li key={r.id}>
            <div className="main"><strong>#{r.id} · {r.kind==='wage'?'工资':r.kind==='commission'?'提成':r.kind==='adjustment'?'补扣款调整':'工资及提成'} · {r.from??r.month} 至 {r.to??r.month}</strong><small>{r.recordCount} 条记录 · 时间工资 {money(r.wageTotalCents??0)} · 原提成 {money(r.commissionTotalCents)} · 扣减 {money(r.deductionTotalCents)} · 应发 {money(r.payableTotalCents)} · 已付 {money(r.paidTotalCents??0)}</small></div>
            <span className={`pill ${TONE[r.status]}`}>{r.statusLabel}</span>
            <button type="button" className="secondary-button small" onClick={() => setOpen(r.id)}>查看</button>
          </li>
        ))}</ul>
      </section>
      {open !== null && d && <DetailDialog id={open} canManage={d.canManage} onClose={() => setOpen(null)} onChanged={load} onOpenSession={onOpenSession} />}
    </div>
  );
}
