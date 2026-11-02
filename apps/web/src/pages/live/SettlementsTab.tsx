import { LIVE_PLATFORMS } from '@kudesi/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { downloadText, toCsv } from '../../resources/csv';
import { liveApi, type SettlementDetail, type SettlementHead } from './liveApi';
import { errText, money, ratePct, yuanText } from './liveFormat';
import { Modal } from './liveUi';

const TONE: Record<string, string> = { draft: '', submitted: 'warn', returned: 'bad', approved: 'ok' };

function DetailDialog({ id, canManage, onClose, onChanged, onOpenSession }: { id: number; canManage: boolean; onClose: () => void; onChanged: () => void; onOpenSession: (sessionId: number) => void }) {
  const [d, setD] = useState<SettlementDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { liveApi.settlement(id).then((x) => { setD(x); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, [id]);
  useEffect(load, [load]);
  async function act(kind: 'recheck' | 'submit') {
    if (!d) return;
    setBusy(true); setError('');
    try { if (kind === 'recheck') await liveApi.generateSettlement(d.month, d.note || undefined,d.from&&d.to?{from:d.from,to:d.to}:undefined); else await liveApi.submitSettlement(d.id); load(); onChanged(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  const editable = canManage && d && (d.status === 'draft' || d.status === 'returned');
  return (
    <Modal error={error} title={d ? `${d.from??d.month} 至 ${d.to??d.month} 工资结算` : '直播工资结算'} size="wide" onClose={onClose} foot={d && <>
      <button type="button" className="secondary-button" onClick={() => downloadText(`直播工资结算-${d.from??d.month}-${d.to??''}.csv`, toCsv([['日期', '平台', '直播间', '人员', '角色', '最终销售额', '比例', '时间工资', '计薪分钟', '时薪', '原提成', '订单数', '退款', '扣减', '应发', '场次编号','填报来源','特殊原因','未核对店铺及原因'], ...d.lines.map((l) => [l.date,LIVE_PLATFORMS[l.platform??'']??'历史场次', l.roomName, l.userName, l.roleLabel, yuanText(l.finalSalesCents), ratePct(l.rateUnits), yuanText(l.wageCents??0),String(l.minutes??0),yuanText(l.hourlyRateCents??0),yuanText(l.commissionCents), String(l.orderCount), yuanText(l.refundCents), yuanText(l.deductionCents), yuanText(l.payableCents), String(l.sessionId),l.source==='manual'?'人事手工':'本人填报',l.manualReason??'',(l.unverifiedStores??[]).map(s=>`${s.name}：${s.reason}`).join('；')])]))}>导出工资报表</button>
      <button className="secondary-button" onClick={()=>downloadText(`订单售后核对-${d.id}.csv`,toCsv([['场次','平台','聚水潭店铺编号','订单号','订单金额','退款金额','核对状态','售后依据','核对时间'],...d.refunds.map(r=>[String(r.sessionId),LIVE_PLATFORMS[r.platform??'']??'',r.shopId??'',r.orderId,yuanText(r.orderAmountCents),yuanText(r.refundCents),r.source==='none'?'无已完成退款':r.source==='cancelled'?'订单已取消':'已完成退款',JSON.stringify(r.details),r.checkedAt])]))}>导出订单售后报表</button>
      {editable && <button type="button" className="secondary-button" disabled={busy} onClick={() => void act('recheck')}>重新核对退款</button>}
      {editable && <button type="button" className="primary-button" disabled={busy} onClick={() => void act('submit')}>{d.status === 'returned' ? '重新提交审批' : '提交审批'}</button>}
    </>}>
      {!d && !error && <p className="muted" role="status">正在读取…</p>}
      {d && (
        <>
          <div className="live-cards"><div className="card live-stat"><span>时间工资合计</span><strong>{money(d.wageTotalCents??0)}</strong></div>
            <div className="card live-stat"><span>原提成合计</span><strong>{money(d.commissionTotalCents)}</strong></div>
            <div className="card live-stat"><span>退款合计</span><strong>{money(d.refundTotalCents)}</strong></div>
            <div className="card live-stat"><span>扣减合计</span><strong>{money(d.deductionTotalCents)}</strong></div>
            <div className="card live-stat"><span>应发合计</span><strong>{money(d.payableTotalCents)}</strong></div>
          </div>
          <p className="muted"><span className={`pill ${TONE[d.status]}`}>{d.statusLabel}</span> 共 {d.recordCount} 条工资提成 · 售后核对于 {d.refundsCheckedAt ?? '—'}（聚水潭只读）{d.flowRunId ? <> · <Link to="/flow/overview">查看审批流程</Link></> : ''}</p>
          {d.status === 'returned' && d.returnReason && <div className="notice warn">已退回：{d.returnReason}。请重新核对后再提交。</div>}
          <strong>按人员</strong>
          <div className="live-scroll"><table className="data-table live-responsive-table" aria-label="按人员汇总"><thead><tr><th>人员</th><th>角色</th><th className="num">场次</th><th className="num">时间工资</th><th className="num">原提成</th><th className="num">扣减</th><th className="num">应发</th></tr></thead>
            <tbody>{d.byPerson.map((p) => <tr key={`${p.userId}${p.role}`}><td data-label="人员">{p.name}</td><td data-label="角色">{p.roleLabel}</td><td data-label="场次" className="num">{p.sessions}</td><td data-label="时间工资" className="num">{money(p.wageCents??0)}</td><td data-label="原提成" className="num">{money(p.commissionCents)}</td><td data-label="扣减" className="num">{money(p.deductionCents)}</td><td data-label="应发" className="num">{money(p.payableCents)}</td></tr>)}</tbody></table></div>
          <strong>明细（点场次查看）</strong>
          <div className="live-scroll"><table className="data-table live-responsive-table" aria-label="结算明细"><thead><tr><th>日期</th><th>直播间</th><th>人员</th><th>角色</th><th className="num">比例</th><th className="num">时间工资</th><th className="num">原提成</th><th className="num">退款</th><th className="num">扣减</th><th className="num">应发</th><th /></tr></thead>
            <tbody>{d.lines.map((l) => <tr key={l.id}><td data-label="日期">{l.date}</td><td data-label="直播间">{l.roomName}<small> · {LIVE_PLATFORMS[l.platform??'']??'历史场次'}</small></td><td data-label="人员">{l.userName}</td><td data-label="角色">{l.roleLabel}</td><td data-label="比例" className="num">{ratePct(l.rateUnits)}</td><td data-label="时间工资" className="num">{money(l.wageCents??0)}<small> · {l.minutes??0} 分</small></td><td data-label="原提成" className="num">{money(l.commissionCents)}</td><td data-label="退款" className="num">{money(l.refundCents)}</td><td data-label="扣减" className="num">{money(l.deductionCents)}</td><td data-label="应发" className="num">{money(l.payableCents)}</td><td data-label="操作"><button type="button" className="link-button" onClick={() => onOpenSession(l.sessionId)}>场次</button></td></tr>)}</tbody></table></div>
          {d.lines.some(l=>l.unverifiedStores?.length)&&<div className="notice warn"><strong>特殊核定，未核对订单</strong><ul>{d.lines.filter((l,i,all)=>l.unverifiedStores?.length&&all.findIndex(x=>x.sessionId===l.sessionId&&x.platform===l.platform)===i).map(l=><li key={`${l.sessionId}:${l.platform}`}>场次 #{l.sessionId} · {LIVE_PLATFORMS[l.platform??'']}：{l.unverifiedStores!.map(s=>`${s.name}：${s.reason}`).join('；')}</li>)}</ul></div>}
          {d.lines.some(l=>l.source==='manual'&&!l.orderCount)&&<div className="notice warn"><strong>特殊核定，未核对订单</strong><ul>{d.lines.filter((l,i,all)=>l.source==='manual'&&!l.orderCount&&all.findIndex(x=>x.sessionId===l.sessionId)===i).map(l=><li key={l.sessionId}>场次 #{l.sessionId}：{l.manualReason}（按人工审核金额核算）</li>)}</ul></div>}
          <strong>订单与售后核对依据（共 {d.refunds.length} 单）</strong>
          {d.refunds.length === 0 ? <p className="muted">本期没有可核对的订单；请检查特殊核定说明。</p> : (
            <div className="live-scroll"><table className="data-table live-responsive-table" aria-label="退款依据"><thead><tr><th>场次</th><th>订单号</th><th className="num">订单金额</th><th className="num">退款</th><th>售后状态与依据</th><th>核对时间</th></tr></thead>
              <tbody>{d.refunds.map((r) => <tr key={`${r.sessionId}:${r.shopId}:${r.orderId}`}><td data-label="场次">#{r.sessionId}</td><td data-label="订单号">{LIVE_PLATFORMS[r.platform??'']??''} · {r.shopId} · {r.orderId}</td><td data-label="订单金额" className="num">{money(r.orderAmountCents)}</td><td data-label="退款" className="num">{money(r.refundCents)}</td><td data-label="售后状态与依据">{r.source === 'cancelled' ? '订单已取消' : r.source==='none'?'无已完成退款':'已完成的售后单'}<details><summary>售后明细</summary><pre>{JSON.stringify(r.details,null,2)}</pre></details></td><td data-label="核对时间">{r.checkedAt}</td></tr>)}</tbody></table></div>
          )}
        </>
      )}
    </Modal>
  );
}

/** 提成月结：人事按月生成（只读核对聚水潭退款）、提交审批；月初 10 天默认上月。 */
export function SettlementsTab({ onOpenSession }: { onOpenSession: (id: number) => void }) {
  const [d, setD] = useState<{ canManage: boolean; defaultMonth: string; rows: SettlementHead[] } | null>(null);
  const [month, setMonth] = useState('');
  const [mode,setMode]=useState('month'),[from,setFrom]=useState(''),[to,setTo]=useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback(() => { liveApi.settlements().then((x) => { setD(x); setMonth((m) => m || x.defaultMonth); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, []);
  useEffect(load, [load]);
  async function generate() {
    setBusy(true); setError('');
    try { const r = await liveApi.generateSettlement(month, note.trim() || undefined,mode==='range'?{from,to}:undefined); load(); setOpen(r.id); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  return (
    <div className="live-page">
      {!d && !error && <p className="muted" role="status">正在读取工资结算…</p>}
      {d?.canManage && (
        <section className="card live-section" aria-label="生成结算单">
          <div className="live-filter">
            <label className="live-field">结算方式<select aria-label="结算方式" value={mode} onChange={e=>setMode(e.target.value)}><option value="month">按月结算</option><option value="range">按日期范围结算</option></select></label>
            {mode==='month'?<label className="live-field">结算月份<input aria-label="结算月份" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>:<><label className="live-field">开始日期<input aria-label="结算开始日期" type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label className="live-field">结束日期<input aria-label="结算结束日期" type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></>}
            <label className="live-field">备注（可选）<input aria-label="结算备注" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <button type="button" className="primary-button" disabled={busy || (mode==='month'?!month:!from||!to)} onClick={() => void generate()}>{busy ? '核对退款中…' : '生成 / 重新核对'}</button>
          </div>
          <details className="live-settlement-help"><summary>结算范围与退款核对说明</summary><p className="muted pad">汇总主播、中控的计时工资及各角色提成。按每场已报订单重新核对聚水潭售后，扣减不超过原提成；人工核定无订单场次单独标明。日期范围不可重叠，范围结束后才能完成审批。</p></details>
        </section>
      )}
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      <section className="card live-section" aria-label="历史结算">
        <h2>历史结算</h2>
        {d && d.rows.length === 0 && <p className="muted pad" role="status">还没有生成过结算单。</p>}
        <ul className="live-list">{d?.rows.map((r) => (
          <li key={r.id}>
            <div className="main"><strong>{r.from??r.month} 至 {r.to??r.month}</strong><small>{r.recordCount} 条记录 · 时间工资 {money(r.wageTotalCents??0)} · 原提成 {money(r.commissionTotalCents)} · 扣减 {money(r.deductionTotalCents)} · 应发 {money(r.payableTotalCents)}</small></div>
            <span className={`pill ${TONE[r.status]}`}>{r.statusLabel}</span>
            <button type="button" className="secondary-button small" onClick={() => setOpen(r.id)}>查看</button>
          </li>
        ))}</ul>
      </section>
      {open !== null && d && <DetailDialog id={open} canManage={d.canManage} onClose={() => setOpen(null)} onChanged={load} onOpenSession={onOpenSession} />}
    </div>
  );
}
