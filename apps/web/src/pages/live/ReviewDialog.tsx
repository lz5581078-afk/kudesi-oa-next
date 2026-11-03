import { CheckoutFeedbackRecords } from './CheckoutFeedback';
import { TrialProxyPerformance } from './TrialProxyPerformance';
import { StorePerformanceTable, storeDrafts, storePayload } from './StorePerformanceTable';
import { LIVE_PLATFORMS } from '@kudesi/shared';
import { useEffect, useMemo, useState } from 'react';
import { LIVE_FINAL_SOURCES } from '@kudesi/shared';
import { flowApi } from '../flow/flowApi';
import { liveApi, type Options, type ReviewForm, type ReviewPreview, type SessionDetail } from './liveApi';
import { errText, hm, money, yuanCents, yuanText } from './liveFormat';
import { manualApiTime } from './manualSessionDraft';
import { Modal } from './liveUi';
import { ReviewPreviewAmounts } from './ReviewPreviewAmounts';
import { ApiError } from '../../api/client';

function ReviewTimeInput({ label, recorded, value, onChange, required = false }: {
  label: string; recorded?: string | null; value: string | null; onChange: (value: string) => void; required?: boolean;
}) {
  return <input type="datetime-local" step="1" aria-label={label} required={required}
    value={(value ?? (required ? '' : recorded) ?? '').replace(' ', 'T')}
    onChange={event => onChange(manualApiTime(event.target.value))} />;
}

/** 一场一张审核单：审核人选最终销售额来源、确认运营和主播工资，右侧随输入试算提成（服务端算）。 */
export function ReviewDialog({ session, onClose, onDone }: { session: SessionDetail; onClose: () => void; onDone: () => void }) {
  const trialProxy = !!session.trialProxyReporter;
  const multi=!!session.channels?.length;
  const abnormal = session.attendance?.filter(a=>a.autoCheckout)??[];
  const [operatorEnd,setOperatorEnd]=useState<string | null>(null);
  const [storeRows,setStoreRows]=useState(()=>storeDrafts(session.channels??[],session.reports.find(r=>r.role==='anchor')?.storeLines));
  const run = session.flow!;
  const [opts, setOpts] = useState<Options | null>(null);
  const [source, setSource] = useState(session.checkinMode?(session.reports.some(r=>r.role==='operator')?'operator':session.reports.some(r=>r.role==='anchor')?'anchor':'control'):'');
  const [manual, setManual] = useState('');
  const [reason, setReason] = useState('');
  const [operator, setOperator] = useState('');
  const [noOperator, setNoOperator] = useState(false);
  const [wStart, setWStart] = useState<string | null>(null);
  const [wEnd, setWEnd] = useState<string | null>(null);
  const [rate, setRate] = useState(yuanText(session.trialHourlyRateCents));
  const [wNote, setWNote] = useState('');
  const [controlRate,setControlRate]=useState(''),[controlStart,setControlStart]=useState<string | null>(null),[controlEnd,setControlEnd]=useState<string | null>(null),[controlNote,setControlNote]=useState('');
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsRefresh,setNeedsRefresh]=useState(false);
  const [stop, setStop] = useState<'' | 'return' | 'reject'>('');
  const [why, setWhy] = useState('');

  useEffect(() => { liveApi.options().then(setOpts).catch(() => setOpts(null)); }, []);
  const reportOf = (role: string) => session.reports.find((r) => r.role === role);
  const available = Object.entries(LIVE_FINAL_SOURCES).filter(([k]) => {
    if (k === 'manual') return true;
    const [role, kind] = k.split('_');
    const r = reportOf(role);
    return !!r && (kind !== 'orders' || r.orderCount > 0);
  });

  /** 表单 → 流程步骤表单（金额用分）；有错返回字符串 */
  const form = useMemo((): ReviewForm | string => {
    const f: ReviewForm = { finalSource: source };
    for(const person of abnormal){
      const value=person.role==='anchor'?wEnd:person.role==='control'?controlEnd:operatorEnd;
      if(!value?.trim())return `${person.name}未报下播，下播时间异常，请修复后再继续`;
    }
    if ([wStart, wEnd, controlStart, controlEnd, operatorEnd].includes('')) return '请填写完整的日期和时间';
    if (operatorEnd) f.operatorEndAt = operatorEnd;
    if(reason.trim())f.finalReason=reason.trim();
    if (source === 'manual') {
      let lines;try{lines=multi?storePayload(storeRows):undefined;}catch(e){return String((e as Error).message);}
      if(lines)f.storeLines=lines;
      const c = lines?lines.reduce((n,l)=>n+l.salesCents,0):yuanCents(manual);
      if (c === null || Number.isNaN(c)) return '请填写手填的最终销售额';
      f.finalSalesCents = c; f.finalReason = reason.trim();
    } else if (reason.trim()) f.finalReason = reason.trim();
    if (noOperator) f.noOperator = true; else if (operator) f.operatorUserId = Number(operator);
    if (wStart) f.wageStartAt = wStart;
    if (wEnd) f.wageEndAt = wEnd;
    if (trialProxy && !rate.trim()) return '请填写本场试播主播时薪';
    if (rate.trim()) { const c = yuanCents(rate); if (c === null || Number.isNaN(c) || c <= 0) return '主播时薪需要是大于 0 的金额'; f.wageHourlyRateCents = c; }
    if (wNote.trim()) f.wageNote = wNote.trim();
    if(controlRate.trim()){const c=yuanCents(controlRate);if(!c||!Number.isSafeInteger(c)||c<=0)return '中控时薪需要是大于 0 的金额';f.controlWageHourlyRateCents=c;}
    if (controlStart) f.controlWageStartAt = controlStart;if (controlEnd) f.controlWageEndAt = controlEnd;if(controlNote.trim())f.controlWageNote=controlNote.trim();
    return f;
  }, [source, manual, reason, operator, noOperator, wStart, wEnd, rate, wNote,controlRate,controlStart,controlEnd,controlNote,storeRows,multi,trialProxy,session.attendance,operatorEnd]);

  // 随输入试算（防抖）；试算失败只提示，不挡住操作
  useEffect(() => {
    if (!source || typeof form === 'string') { setPreview(null); setPreviewErr(typeof form === 'string' && source ? form : ''); return; }
    if (source === 'manual' && !form.finalReason) { setPreview(null); setPreviewErr('手填最终销售额必须写原因'); return; }
    let current=true;setPreview(null);setPreviewErr('');
    const t = setTimeout(() => { liveApi.reviewPreview(session.id, form).then((p) => { if(current){setPreview(p);setPreviewErr('');} }).catch((e) => { if(current){setPreview(null);setPreviewErr(errText(e));} }); }, 300);
    return () => {current=false;clearTimeout(t);};
  }, [form, source, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(kind: 'pass' | 'return' | 'reject') {
    if(busy||needsRefresh)return;
    setError('');
    if (kind === 'pass') {
      if (!source) return setError('请选择最终销售额的来源');
      if (typeof form === 'string') return setError(form);
      if (source === 'manual' && !form.finalReason) return setError('手填最终销售额必须写原因');
    } else if (!why.trim()) return setError(kind === 'return' ? '退回要写原因' : '拒绝要写原因');
    setBusy(true);
    try {
      const base = { revision: run.revision, stepId: run.activeStep!.id };
      if (kind === 'pass') await flowApi.pass(run.id, { ...base, form: form as Record<string, unknown> });
      else if (kind === 'return') await flowApi.back(run.id, { ...base, reason: why.trim() });
      else await flowApi.reject(run.id, { ...base, reason: why.trim() });
      onDone();
    } catch (e) {
      const status=e instanceof ApiError?e.status:null;
      const detail=errText(e,'审核请求未完成');
      setError(status?`${detail}（HTTP ${status}）`:detail);
      if(!status||status>=500||status===409){
        setNeedsRefresh(true);
        setError(`${status?`审核请求未完成（HTTP ${status}）`:'审核请求结果暂未确认'}：${detail}。请先刷新场次核对结果，再继续操作。`);
      }
    } finally { setBusy(false); }
  }

  return (
    <Modal title="审核直播场次" size="wide" onClose={onClose} foot={<div className="live-review-footer">{error&&<div role="alert" className="notice error">{error}</div>}{needsRefresh&&<button type="button" className="secondary-button" disabled={busy} onClick={onDone}>刷新场次核对结果</button>}<div className="live-review-footer-actions">{stop ? <>
      <button type="button" className="secondary-button" onClick={() => setStop('')}>返回</button>
      <button type="button" className={`primary-button ${stop === 'reject' ? 'danger-fill' : ''}`} disabled={busy||needsRefresh} onClick={() => void act(stop)}>{stop === 'return' ? '确认退回' : '确认拒绝'}</button>
    </> : <>
      {run.me.canReturn && <button type="button" className="secondary-button" onClick={() => setStop('return')}>退回修改</button>}
      {run.me.canReject && <button type="button" className="secondary-button danger" onClick={() => setStop('reject')}>拒绝</button>}
      <button type="button" className="primary-button" disabled={busy || needsRefresh || !run.me.canPass} onClick={() => void act('pass')}>{busy ? '提交中…' : '审核通过'}</button>
    </>}</div></div>}>
      <p className="muted live-review-summary">{session.roomName} · {session.date} {hm(session.startAt)}–{hm(session.endAt)} · 主播 {session.anchor.name}{session.control ? `，中控 ${session.control.name}` : ''}</p>
      <TrialProxyPerformance session={session}/>
      {!!abnormal.length&&<div className="notice error" role="alert">{abnormal.map(a=>a.name).join('、')}：未报下播，下播时间异常。系统已在锁定时自动下播，请核实并填写正确下播时间后再继续。</div>}
      <CheckoutFeedbackRecords sessionId={session.id} records={session.checkoutFeedback} attendance={session.attendance}/>
      <section className="live-detail-section"><h3>核对下播报告</h3><div className="live-scroll"><table className="data-table live-responsive-table" aria-label="上报对比">
        <thead><tr><th>角色</th><th>填报人</th><th className="num">所报销售额</th><th className="num">勾选订单合计</th><th className="num">订单数</th><th className="num">投流</th></tr></thead>
        <tbody>{session.reports.map((r) => <tr key={r.role}><td data-label="角色">{r.roleLabel}</td><td data-label="填报人">{r.reporter.name}</td><td data-label="所报销售额" className="num">{money(r.salesCents)}</td><td data-label="勾选订单合计" className="num">{money(r.ordersTotalCents)}</td><td data-label="订单数" className="num">{r.orderCount}</td><td data-label="投流" className="num">{money(r.adSpendCents)}</td></tr>)}</tbody>
      </table></div></section>
      {multi&&<details className="live-review-store-compare"><summary>查看分平台 · 店铺上报对比（{session.reports.reduce((count,report)=>count+(report.storeLines?.length??0),0)} 条）</summary><div className="live-scroll"><table className="data-table live-responsive-table" aria-label="逐店上报对比"><thead><tr><th>平台 / 店铺</th><th>角色</th><th>营业额</th><th>投流</th><th>订单核对</th></tr></thead><tbody>{session.reports.flatMap(r=>(r.storeLines??[]).map(l=><tr key={`${r.role}:${l.storeId}`}><td data-label="平台 / 店铺">{LIVE_PLATFORMS[l.platform]} · {session.channels!.flatMap(c=>c.stores).find(s=>s.id===l.storeId)?.name}</td><td data-label="角色">{r.roleLabel}</td><td data-label="营业额">{money(l.salesCents)}</td><td data-label="投流">{r.role==='control'?money(l.adSpendCents):'—'}</td><td data-label="订单核对">{l.verified?`已核对 ${money(l.ordersTotalCents??0)}`:`特殊核定：${l.reason||'未核对订单'}`}</td></tr>))}</tbody></table></div></details>}
      {stop ? (
        <label className="live-field">{stop === 'return' ? '退回原因（主播或中控修改后重新提交）' : '拒绝原因（场次回到已退回，需重新发起审核）'}<textarea aria-label="原因" rows={3} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} /></label>
      ) : (
        <>
          <fieldset><legend>最终销售额</legend>
            {abnormal.some(a=>a.role==='operator')&&<label className="live-field">运营下播时间（异常修复，必填）<ReviewTimeInput label="运营下播时间" value={operatorEnd} onChange={setOperatorEnd} required /></label>}
            {session.controlCommissionOnly&&abnormal.some(a=>a.role==='control')&&<label className="live-field">中控下播时间（异常修复，必填）<ReviewTimeInput label="中控计薪结束" value={controlEnd} onChange={setControlEnd} required /></label>}
            <div className="live-fields">
              <label className="live-field">来源<select aria-label="最终销售额来源" value={source} onChange={(e) => setSource(e.target.value)}><option value="">请选择</option>{available.map(([k, label]) => <option key={k} value={k}>{session.anchorTrial&&k.startsWith('control')?`${label}（试播代报依据）`:label}{k !== 'manual' ? `（${money(Number(k.endsWith('orders') ? reportOf(k.split('_')[0])?.ordersTotalCents : reportOf(k)?.salesCents))}）` : ''}</option>)}</select></label>
              {source === 'manual' && !multi && <label className="live-field">手填金额（元）<input aria-label="手填最终销售额" inputMode="decimal" value={manual} onChange={(e) => setManual(e.target.value)} /></label>}
              {source && <label className="live-field wide">{source === 'manual'||(session.reports.some(r=>r.role==='operator')&&source!=='operator') ? '核定原因（必填）' : '说明（可选）'}<textarea rows={2} aria-label="最终销售额说明" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
            </div>
            {source==='manual'&&multi&&<StorePerformanceTable channels={session.channels!} rows={storeRows} onChange={setStoreRows}/>}
          </fieldset>
          <fieldset><legend>运营人员（由人事最终确认）</legend>
            <div className="live-fields">
              <label className="live-field">运营<select aria-label="运营人员" disabled={noOperator} value={operator} onChange={(e) => setOperator(e.target.value)}><option value="">沿用{session.operator ? `：${session.operator.name}` : '（排场未填）'}</option>{opts?.operators.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label className="live-field" style={{ justifyContent: 'flex-end' }}><span><input type="checkbox" checked={noOperator} onChange={(e) => setNoOperator(e.target.checked)} /> 本场没有运营人员</span></label>
            </div>
          </fieldset>
          <fieldset><legend>主播工资（按小时）</legend><p className="live-section-help">本场计时工资只计算一次，不随直播平台数量增加。</p>
            <div className="live-fields">
              <label className="live-field">上播时间<ReviewTimeInput label="工资上播时间" recorded={session.attendance?.find(a => a.role === 'anchor')?.startAt ?? session.startAt} value={wStart} onChange={setWStart} /></label>
              <label className="live-field">下播时间<ReviewTimeInput label="工资下播时间" recorded={session.attendance?.find(a => a.role === 'anchor')?.endAt ?? session.endAt} value={wEnd} onChange={setWEnd} required={abnormal.some(a => a.role === 'anchor')} /></label>
              <label className={trialProxy ? 'live-field trial-rate-required' : 'live-field'}>{trialProxy ? '试播主播时薪（元/小时）· 必填' : '时薪（元/小时）'}<input required={trialProxy} aria-label="主播时薪" inputMode="decimal" placeholder={trialProxy ? '请填写本场时薪' : preview?.wage.archiveHourlyRateCents ? `档案 ${yuanText(preview.wage.archiveHourlyRateCents)}` : '档案没有计时时薪，必填'} value={rate} onChange={(e) => setRate(e.target.value)} /></label>
              <label className="live-field wide">调整说明（可选）<input maxLength={500} value={wNote} onChange={(e) => setWNote(e.target.value)} /></label>
            </div>
          </fieldset>
            {session.controlCommissionOnly && <p>传统运营人员担任中控，仅按中控规则计提成，记入本人运营提成。</p>}
            {session.control&&!session.controlCommissionOnly&&<fieldset><legend>中控计时工资</legend><div className="live-fields"><label className="live-field">计薪开始<ReviewTimeInput label="中控计薪开始" recorded={session.attendance?.find(a => a.role === 'control')?.startAt ?? session.startAt} value={controlStart} onChange={setControlStart} /></label><label className="live-field">计薪结束<ReviewTimeInput label="中控计薪结束" recorded={session.attendance?.find(a => a.role === 'control')?.endAt ?? session.endAt} value={controlEnd} onChange={setControlEnd} required={abnormal.some(a => a.role === 'control')} /></label><label className="live-field">中控时薪（元）<input aria-label="中控时薪" placeholder="默认取计时时薪档案" value={controlRate} onChange={e=>setControlRate(e.target.value)}/></label><label className="live-field">工资调整说明<input aria-label="中控工资说明" value={controlNote} onChange={e=>setControlNote(e.target.value)}/></label></div></fieldset>}
          <div className="live-preview" aria-label="审核试算" role="status">
            <strong>试算结果（服务端按规则计算）</strong>
            {previewErr && <span className="notice warn">{previewErr}</span>}

          {preview && <ReviewPreviewAmounts preview={preview}/>}
            {!preview && !previewErr && <span className="muted">选择最终销售额来源后显示</span>}
          </div>
        </>
      )}
    </Modal>
  );
}
