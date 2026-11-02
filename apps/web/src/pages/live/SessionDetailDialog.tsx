import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LIVE_FINAL_SOURCES, LIVE_PLATFORMS } from '@kudesi/shared';
import { liveApi, type SessionDetail } from './liveApi';
import { dt, errText, hm, minutesText, money, ratePct, roi } from './liveFormat';
import { Modal, PreviewBox, SessionPill, names } from './liveUi';
import { ReportDialog } from './ReportDialog';
import { ReviewDialog } from './ReviewDialog';
import { SubmissionNotice } from './SubmissionNotice';

/** 场次详情：基本信息、产品、上报对比、提成与工资；本人可报下播/提交审核，审核人可审核。 */
export function SessionDetailDialog({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged?: () => void }) {
  const [s, setS] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'' | 'report' | 'review'>('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const load = useCallback(() => { liveApi.session(id).then((d) => { setS(d); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, [id]);
  useEffect(load, [load]);
  useEffect(() => { setSubmitted(false); setSubmitError(''); }, [id]);
  const changed = () => { setMode(''); load(); onChanged?.(); };

  async function submit() {
    setBusy(true); setSubmitError('');
    try { await liveApi.submit(id); setSubmitted(true); changed(); } catch (e) { setSubmitError(errText(e)); load(); } finally { setBusy(false); }
  }
  if (mode === 'report' && s) return <ReportDialog session={s} onClose={() => setMode('')} onDone={changed} />;
  if (mode === 'review' && s?.flow) return <ReviewDialog session={s} onClose={() => setMode('')} onDone={changed} />;
  const joinRole=s?.checkinMode&&s.status==='live'&&!s.reportDeadline?s.me.reportRoles.find(r=>r!=='operator'&&!s.myCheckins?.some(c=>c.role===r)):null;
  const canReview = !!s?.flow?.me.canPass && s.status === 'submitted';
  return (
    <Modal title="直播场次" size="wide" bodyClassName="live-session-detail" onClose={onClose} foot={s && <div className="live-session-footer">
      {submitError && <div role="alert" className="notice error">{submitError}</div>}
      {submitted && <div role="status" className="notice ok">已提交审核，请等待审核人处理。</div>}
      {s.me.canSubmit && s.submission && <SubmissionNotice status={s.submission} onRefresh={load} />}
      <div className="live-actions">
      <button type="button" className="secondary-button" onClick={onClose}>关闭详情</button>
      {joinRole&&<button type="button" className="primary-button live-clock-button" disabled={busy} onClick={async()=>{setBusy(true);setSubmitError('');try{await liveApi.start({sessionId:s.id,confirmDetails:true});changed();}catch(e){setSubmitError(errText(e));}finally{setBusy(false);}}}>已核对下方人员、账号、店铺和产品，确认本人上播</button>}
      {s.me.reportRoles.length > 0 && !joinRole && <button type="button" className="primary-button live-clock-button" onClick={() => setMode('report')}>{s.reports.some((r) => s.me.reportRoles.includes(r.role)) ? '修改下播报告' : s.status === 'live' ? '报下播' : '补报下播'}</button>}
      {s.me.canSubmit && !submitted && <button type="button" className="primary-button" disabled={busy || s.submission?.ready === false} onClick={() => void submit()}>{busy ? '提交中…' : s.status === 'returned' ? '重新提交审核' : '提交审核'}</button>}
      {canReview && <button type="button" className="primary-button" onClick={() => setMode('review')}>审核</button>}
      </div>
    </div>}>
      {error && <div role="alert" className="notice error">{error}</div>}
      {!s && !error && <p className="muted" role="status">正在读取…</p>}
      {s && (
        <>
          <div className="between"><strong>{s.roomName} · {s.date}</strong><SessionPill status={s.status} label={s.statusLabel} /></div>
          {s.status === 'returned' && s.returnReason && <div className="notice warn">已退回：{s.returnReason}。请修改下播报告后重新提交。</div>}
          {s.reportSource==='manual'&&<p className="notice warn">人事手工填报 · 经办人编号 #{s.manualActorId} · 原因：{s.manualReason}</p>}
          {s.checkinMode&&<div className="notice warn">{s.reportDeadline?`${s.reportsLocked?'本场已锁定':'报下播截止'}：${s.reportDeadline}，锁定后其他岗位不能再报。`:'首位报下播后开始30分钟补报倒计时。'}{s.autoSubmitError&&` 自动提交待处理：${s.autoSubmitError}`}{s.ordersCaptureStatus==='pending'&&` 订单待核对：${s.ordersCaptureError??'正在归集'}`}<br/>审核以运营填报为主要依据；没有运营报告时可按主播报告审核。</div>}
          <dl className="live-fields">
            <div><dt className="muted">时间</dt><dd>{hm(s.startAt)} – {s.endAt ? hm(s.endAt, s.date) : '直播中'}</dd></div>
            <div><dt className="muted">主播 / 中控 / 运营</dt><dd>{names(s.anchor)}{s.control ? ` / ${s.control.name}` : ''}{s.operator ? ` / ${s.operator.name}` : ''}</dd></div>
            <div><dt className="muted">直播号 / 店铺</dt><dd>{s.channels?.length?s.channels.map(c=>`${LIVE_PLATFORMS[c.platform]} ${c.accountName} / ${c.stores.map(s=>s.name).join("、")}`).join("；"):s.douyinAccount.name}</dd></div>
            {s.finalSalesCents !== null && <div><dt className="muted">最终销售额</dt><dd>{money(s.finalSalesCents)}（{LIVE_FINAL_SOURCES[s.finalSalesSource ?? ''] ?? ''}{s.finalSalesReason ? `：${s.finalSalesReason}` : ''}）</dd></div>}
            {s.approvedAt && <div><dt className="muted">审核</dt><dd>{s.approverName} · {dt(s.approvedAt)}</dd></div>}
          </dl>
          <div><strong>{s.products.length ? `在卖产品（${s.products.length}）` : '未登记在卖产品'}</strong><div className="live-chips">{s.products.map((p, i) => <span key={p.id ?? `manual-${i}`} className="pill" title={p.spec}>{p.code} {p.name}</span>)}</div></div>
          {s.reports.length > 0 ? (
            <div className="live-scroll"><table className="data-table" aria-label="下播报告">
              <thead><tr><th>角色</th><th>填报人</th><th>下播时间</th><th className="num">销售额</th><th className="num">订单合计</th><th className="num">订单数</th><th className="num">投流</th></tr></thead>
              <tbody>{s.reports.map((r) => <tr key={r.role}><td data-label="角色">{r.roleLabel}</td><td data-label="填报人">{r.reporter.name}{r.manualActorId?'（人事代报）':''}</td><td data-label="下播时间">{hm(r.endAt, s.date)}</td><td data-label="销售额" className="num">{money(r.salesCents)}</td><td data-label="订单合计" className="num">{money(r.ordersTotalCents)}</td><td data-label="订单数" className="num">{r.orderCount}</td><td data-label="投流" className="num">{money(r.adSpendCents)}</td></tr>)}</tbody>
            </table></div>
          ) : <p className="muted">还没有人报下播。</p>}
          {s.channels?.length&&<div className="live-scroll"><table className="data-table" aria-label="店铺业绩明细"><thead><tr><th>平台 / 店铺</th><th>填报角色</th><th>营业额</th><th>投流</th><th>订单核对</th></tr></thead><tbody>{s.reports.flatMap(r=>(r.storeLines??[]).map(l=><tr key={`${r.role}:${l.storeId}`}><td data-label="平台 / 店铺">{LIVE_PLATFORMS[l.platform]} · {s.channels!.flatMap(c=>c.stores).find(v=>v.id===l.storeId)?.name}</td><td data-label="填报角色">{r.roleLabel}</td><td data-label="营业额">{money(l.salesCents)}</td><td data-label="投流">{r.role==='control'?money(l.adSpendCents):'—'}</td><td data-label="订单核对">{l.verified?'已核对订单':`特殊核定：${l.reason||'未核对订单'}`}</td></tr>))}</tbody></table></div>}
          {s.reports.filter(r=>r.note).map(r=><p key={r.role}><strong>{r.roleLabel}填报内容：</strong>{r.note}</p>)}
          {!!s.capturedOrders?.length&&<details><summary>本场自动归集订单（{s.capturedOrders.length}单）</summary><div className="live-scroll"><table className="data-table"><thead><tr><th>平台 / 店铺</th><th>订单号</th><th>成单时间</th><th>订单额</th><th>退款</th><th>状态</th></tr></thead><tbody>{s.capturedOrders.map(o=><tr key={`${o.shopId}:${o.orderId}`}><td>{LIVE_PLATFORMS[o.platform]} · {o.shopId}</td><td>{o.orderId}</td><td>{o.orderAt}</td><td>{money(o.amountCents)}</td><td>{money(o.refundCents)}</td><td>{o.paid?'已付款':'待付款'} · {o.status}</td></tr>)}</tbody></table></div></details>}
          <PreviewBox preview={s.preview} />
          {s.commissions.length > 0 && (
            <div><strong>提成记录</strong>
              <ul className="live-amounts">{s.commissions.map((c) => <li key={`${c.role}:${c.platform??""}`}><span>{LIVE_PLATFORMS[c.platform??""]??""} {c.roleLabel} {c.name}</span><strong>{money(c.amountCents)}</strong><small>{ratePct(c.rateUnits)}{c.belowRoi ? ' · 投产不足已扣减' : ''}{c.roiScaled !== null ? ` · 投产 ${roi(c.roiScaled)}` : ''}</small></li>)}</ul>
            </div>
          )}
          {(s.wages??(s.wage?[{...s.wage,role:'anchor'}]:[])).map(w=><p key={w.role}>{w.role==='control'?'中控':'主播'}工资：{minutesText(w.minutes)} × {money(w.hourlyRateCents)}/小时 = <strong>{money(w.amountCents)}</strong>{w.note ? `（${w.note}）` : ''}</p>)}
          {s.flow && <p className="muted">审核流程：<Link to={`/flow/overview`}>{s.flow.title}</Link> · {s.flow.status === 'running' ? `当前步骤「${s.flow.activeStep?.name ?? ''}」` : '已结束'}</p>}
        </>
      )}
    </Modal>
  );
}
