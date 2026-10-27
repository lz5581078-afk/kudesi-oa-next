import { useEffect, useMemo, useState } from 'react';
import { LIVE_FINAL_SOURCES } from '@kudesi/shared';
import { flowApi } from '../flow/flowApi';
import { liveApi, type Options, type ReviewForm, type ReviewPreview, type SessionDetail } from './liveApi';
import { errText, hm, minutesText, money, roi, yuanCents, yuanText } from './liveFormat';
import { Modal, RoleAmounts } from './liveUi';

/** 一场一张审核单：审核人选最终销售额来源、确认运营和主播工资，右侧随输入试算提成（服务端算）。 */
export function ReviewDialog({ session, onClose, onDone }: { session: SessionDetail; onClose: () => void; onDone: () => void }) {
  const run = session.flow!;
  const [opts, setOpts] = useState<Options | null>(null);
  const [source, setSource] = useState('');
  const [manual, setManual] = useState('');
  const [reason, setReason] = useState('');
  const [operator, setOperator] = useState('');
  const [noOperator, setNoOperator] = useState(false);
  const [wStart, setWStart] = useState('');
  const [wEnd, setWEnd] = useState('');
  const [rate, setRate] = useState('');
  const [wNote, setWNote] = useState('');
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
    if (source === 'manual') {
      const c = yuanCents(manual);
      if (c === null || Number.isNaN(c)) return '请填写手填的最终销售额';
      f.finalSalesCents = c; f.finalReason = reason.trim();
    } else if (reason.trim()) f.finalReason = reason.trim();
    if (noOperator) f.noOperator = true; else if (operator) f.operatorUserId = Number(operator);
    if (wStart.trim()) f.wageStartAt = wStart.trim().length === 16 ? `${wStart.trim()}:00` : wStart.trim();
    if (wEnd.trim()) f.wageEndAt = wEnd.trim().length === 16 ? `${wEnd.trim()}:00` : wEnd.trim();
    if (rate.trim()) { const c = yuanCents(rate); if (c === null || Number.isNaN(c) || c <= 0) return '主播时薪需要是大于 0 的金额'; f.wageHourlyRateCents = c; }
    if (wNote.trim()) f.wageNote = wNote.trim();
    return f;
  }, [source, manual, reason, operator, noOperator, wStart, wEnd, rate, wNote]);

  // 随输入试算（防抖）；试算失败只提示，不挡住操作
  useEffect(() => {
    if (!source || typeof form === 'string') { setPreview(null); setPreviewErr(typeof form === 'string' && source ? form : ''); return; }
    if (source === 'manual' && !form.finalReason) { setPreview(null); setPreviewErr('手填最终销售额必须写原因'); return; }
    setPreviewErr('');
    const t = setTimeout(() => { liveApi.reviewPreview(session.id, form).then((p) => { setPreview(p); setPreviewErr('') }).catch((e) => { setPreview(null); setPreviewErr(errText(e)); }); }, 300);
    return () => clearTimeout(t);
  }, [form, source, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(kind: 'pass' | 'return' | 'reject') {
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
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="审核直播场次" size="wide" onClose={onClose} foot={stop ? <>
      <button type="button" className="secondary-button" onClick={() => setStop('')}>返回</button>
      <button type="button" className={`primary-button ${stop === 'reject' ? 'danger-fill' : ''}`} disabled={busy} onClick={() => void act(stop)}>{stop === 'return' ? '确认退回' : '确认拒绝'}</button>
    </> : <>
      {run.me.canReturn && <button type="button" className="secondary-button" onClick={() => setStop('return')}>退回修改</button>}
      {run.me.canReject && <button type="button" className="secondary-button danger" onClick={() => setStop('reject')}>拒绝</button>}
      <button type="button" className="primary-button" disabled={busy || !run.me.canPass} onClick={() => void act('pass')}>{busy ? '提交中…' : '审核通过'}</button>
    </>}>
      {error && <div role="alert" className="notice error">{error}</div>}
      <p className="muted">{session.roomName} · {session.date} {hm(session.startAt)}–{hm(session.endAt)} · 主播 {session.anchor.name}{session.control ? `，中控 ${session.control.name}` : ''}</p>
      <div className="live-scroll"><table className="data-table" aria-label="上报对比">
        <thead><tr><th>角色</th><th>填报人</th><th className="num">所报销售额</th><th className="num">勾选订单合计</th><th className="num">订单数</th><th className="num">投流</th></tr></thead>
        <tbody>{session.reports.map((r) => <tr key={r.role}><td>{r.roleLabel}</td><td>{r.reporter.name}</td><td className="num">{money(r.salesCents)}</td><td className="num">{money(r.ordersTotalCents)}</td><td className="num">{r.orderCount}</td><td className="num">{money(r.adSpendCents)}</td></tr>)}</tbody>
      </table></div>
      {stop ? (
        <label className="live-field">{stop === 'return' ? '退回原因（主播或中控修改后重新提交）' : '拒绝原因（场次回到已退回，需重新发起审核）'}<textarea aria-label="原因" rows={3} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} /></label>
      ) : (
        <>
          <fieldset><legend>最终销售额</legend>
            <div className="live-fields">
              <label className="live-field">来源<select aria-label="最终销售额来源" value={source} onChange={(e) => setSource(e.target.value)}><option value="">请选择</option>{available.map(([k, label]) => <option key={k} value={k}>{label}{k !== 'manual' ? `（${money(Number(k.endsWith('orders') ? reportOf(k.split('_')[0])?.ordersTotalCents : reportOf(k)?.salesCents))}）` : ''}</option>)}</select></label>
              {source === 'manual' && <label className="live-field">手填金额（元）<input aria-label="手填最终销售额" inputMode="decimal" value={manual} onChange={(e) => setManual(e.target.value)} /></label>}
              {source && <label className="live-field wide">{source === 'manual' ? '手填原因（必填）' : '说明（可选）'}<input aria-label="最终销售额说明" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
            </div>
          </fieldset>
          <fieldset><legend>运营人员（由人事最终确认）</legend>
            <div className="live-fields">
              <label className="live-field">运营<select aria-label="运营人员" disabled={noOperator} value={operator} onChange={(e) => setOperator(e.target.value)}><option value="">沿用{session.operator ? `：${session.operator.name}` : '（排场未填）'}</option>{opts?.operators.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label className="live-field" style={{ justifyContent: 'flex-end' }}><span><input type="checkbox" checked={noOperator} onChange={(e) => setNoOperator(e.target.checked)} /> 本场没有运营人员</span></label>
            </div>
          </fieldset>
          <fieldset><legend>主播工资（按小时）</legend>
            <div className="live-fields">
              <label className="live-field">上播时间<input aria-label="工资上播时间" placeholder={session.startAt.slice(0, 16)} value={wStart} onChange={(e) => setWStart(e.target.value)} /></label>
              <label className="live-field">下播时间<input aria-label="工资下播时间" placeholder={(session.endAt ?? '').slice(0, 16)} value={wEnd} onChange={(e) => setWEnd(e.target.value)} /></label>
              <label className="live-field">时薪（元/小时）<input aria-label="主播时薪" inputMode="decimal" placeholder={preview?.wage.archiveHourlyRateCents ? `档案 ${yuanText(preview.wage.archiveHourlyRateCents)}` : '档案没有计时时薪，必填'} value={rate} onChange={(e) => setRate(e.target.value)} /></label>
              <label className="live-field wide">调整说明（可选）<input maxLength={500} value={wNote} onChange={(e) => setWNote(e.target.value)} /></label>
            </div>
          </fieldset>
          <div className="live-preview" aria-label="审核试算" role="status">
            <strong>试算结果（服务端按规则计算）</strong>
            {previewErr && <span className="notice warn">{previewErr}</span>}
            {preview && (
              <>
                <span>最终销售额 {money(preview.finalSalesCents)} · 投流 {money(preview.adSpendCents)} · 投产 {roi(preview.roiScaled)}{preview.belowRoi ? '（不足，已扣减点数）' : ''} · 规则版本 {preview.ruleVersion.effectiveFrom} 起</span>
                <RoleAmounts anchor={preview.anchor} control={preview.control} operator={preview.operator} />
                {preview.operatorDoubledAsControl && <small className="muted">运营兼任中控，不另算运营提成</small>}
                <span>主播工资：{minutesText(preview.wage.minutes)} × {money(preview.wage.hourlyRateCents)}/小时 = <strong>{money(preview.wage.amountCents)}</strong>（{preview.wage.rateSource === 'archive' ? '档案时薪' : '手填时薪'}）</span>
              </>
            )}
            {!preview && !previewErr && <span className="muted">选择最终销售额来源后显示</span>}
          </div>
        </>
      )}
    </Modal>
  );
}
