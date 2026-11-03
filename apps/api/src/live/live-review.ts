import { reportsLocked } from './live-checkin-core';
import { liveClock } from './live-core';
import { commissionOnlyControl } from './live-access';
import { channelsOf, channelStores, linesOf } from './live-platforms';
import { LiveStoreLine, livePlatformCommissions } from '@kudesi/shared';
import { EntityManager } from 'typeorm';
import {
  LIVE_FINAL_SOURCES, liveArchiveHourlyRate, liveComputeCommission, liveComputeWage, liveFromText, liveMissingReporter, liveToText, liveVersionFor,
  type LiveRules,
} from '@kudesi/shared';
import { Row, closedDay, liveFail, lockCompany, reportsOf, ruleVersions, sessionRow, wallNow } from './live-core';

/** 主播和本场中控须有本人报告；有明确经办人和原因的人事补报也可进入审核。运营选填。 */
export function requireReports(session: Row, reports: Row[]) {
  if(Number(session.trial_proxy)){
    if(!reports.some(r=>r.role==='control'&&Number(r.reporter_user_id)===Number(session.control_user_id)))liveFail('试播场次须由本场中控确认试播主播并报下播',400);
    return;
  }
  if(session.checkin_mode && session.report_locked_at && reports.length)return;
  const missing = liveMissingReporter(
    reports.map((r) => ({ role: String(r.role), reporterId: Number(r.manual_actor_id ? (r.role==='anchor'?session.anchor_user_id:session.control_user_id):r.reporter_user_id) })),
    { anchorId: Number(session.anchor_user_id), controlId: session.control_user_id ? Number(session.control_user_id) : null },
  );
  if (missing === 'anchor') liveFail('主播还没有报下播（须本人填报），请主播本人填报后再提交', 400);
  if (missing === 'control') liveFail('中控还没有报下播（须本人填报），请中控本人填报后再提交', 400);
}

/** 能不能提交审核：状态对、两人都本人报过。 */
export async function checkSubmittable(em: EntityManager, companyId: number, session: Row) {
  if (!['pending_report', 'returned'].includes(session.status)) liveFail(session.status === 'live' ? '还没有人报下播，请先报下播' : '场次当前状态不能提交审核');
  if(session.checkin_mode&&!reportsLocked(session,liveClock.now()))liveFail('首位报下播后满30分钟自动锁场并提交审核，请等待其他岗位填报',409);
  requireReports(session, await reportsOf(em, companyId, Number(session.id)));
}

/** 审核表单（流程步骤表单）里的字段。 */
export interface ReviewForm {
  storeLines?:LiveStoreLine[];
  finalSource?: string; finalSalesCents?: number; finalReason?: string;
  operatorUserId?: number; noOperator?: boolean;
  wageStartAt?: string; wageEndAt?: string; wageHourlyRateCents?: number; wageNote?: string; controlWageStartAt?:string; controlWageEndAt?:string; controlWageHourlyRateCents?:number; controlWageNote?:string;
}

/** 审核人选择的最终销售额：选其中一个上报值，或手填并写原因。 */
export function resolveFinalSales(form: ReviewForm, reports: Row[], operatorPrimary=false): { source: string; cents: number; reason: string | null } {
  const source = String(form.finalSource || (reports.some(r=>r.role==='operator')?'operator':reports.some(r=>r.role==='anchor')?'anchor':'control'));
  if(operatorPrimary&&reports.some(r=>r.role==='operator')&&source!=='operator'&&!String(form.finalReason||'').trim())liveFail('本场以运营填报为主要依据，改用其他来源请填写原因',400);
  if (!LIVE_FINAL_SOURCES[source]) liveFail('请选择本场最终销售额的来源', 400);
  if (source === 'manual') {
    if(form.storeLines&&(!Array.isArray(form.storeLines)||form.storeLines.length>400||form.storeLines.some(l=>!l||typeof l!=='object'||!Number.isSafeInteger(l.salesCents)||l.salesCents<0||!Number.isSafeInteger(l.adSpendCents)||l.adSpendCents<0)))liveFail('请按店铺填写有效最终业绩明细',400);
    if (form.storeLines) form = {...form,finalSalesCents:form.storeLines.reduce((n,l)=>n+l.salesCents,0)};
    if (!Number.isSafeInteger(form.finalSalesCents) || form.finalSalesCents! < 0 || form.finalSalesCents! > 10_000_000_000) liveFail('请填写手填的最终销售额', 400);
    const reason = String(form.finalReason || '').trim();
    if (!reason || reason.length > 500) liveFail('手填最终销售额时请写明原因（最多 500 字）', 400);
    return { source, cents: form.finalSalesCents as number, reason };
  }
  const [role, kind] = source.split('_');
  const report = reports.find((r) => r.role === role);
  if (!report) liveFail(`${role === 'anchor' ? '主播' : '中控'}没有报下播，不能选择该值`, 400);
  const orders = kind === 'orders';
  if (orders && !Number(report!.order_count)) liveFail('所选上报值没有勾选订单，请选择其他来源或手填', 400);
  const cents = Number(orders ? report!.orders_total_cents : report!.sales_cents);
  return { source, cents, reason: String(form.finalReason || '').trim().slice(0, 500) || null };
}

/** Resolve shop lines from the chosen report or reviewer input; never prorate a session total. */
export function resolvePlatformSales(session: Row, reports: Row[], form: ReviewForm) {
  const stores=channelStores(channelsOf(session));
  if(!stores.length) return null;
  if(!LIVE_FINAL_SOURCES[form.finalSource || '']) liveFail('请选择最终销售额来源',400);
  const manual=form.finalSource==='manual';
  const role=String(form.finalSource).split('_')[0];
  const base=reports.find(r=>r.role===role);
  const source=manual ? form.storeLines??[] : base ? linesOf(base) : [];
  if(source.length!==stores.length||new Set(source.map(l=>l.storeId)).size!==stores.length) liveFail('最终业绩必须包含本场所有店铺，不能按总额分摊',400);
  if(manual&&!String(form.finalReason||'').trim())liveFail('人工核定必须填写原因',400);
  const control=reports.find(r=>r.role==='control');
  const ads=control?linesOf(control):[];
  return stores.map(store=>{
    const line=source.find(l=>l.storeId===store.id);
    if(!line||line.platform!==store.platform)liveFail('审核店铺或平台与本场不符',400);
    if(form.finalSource?.endsWith('_orders')&&!line!.verified)liveFail('有店铺未核对订单，不能选订单合计',400);
    const sales=Number(form.finalSource?.endsWith('_orders')?line!.ordersTotalCents:line!.salesCents);
    const ad=manual?line!.adSpendCents:ads.find(l=>l.storeId===store.id)?.adSpendCents??null;
    if(!Number.isSafeInteger(sales)||sales<0||sales>10_000_000_000||ad!==null&&(!Number.isSafeInteger(ad)||ad<0||ad>10_000_000_000))liveFail('逐店核定金额不正确',400);
    return {storeId:store.id,platform:store.platform,salesCents:sales,adSpendCents:ad};
  });
}
function commissionResults(rules: LiveRules,session:Row,reports:Row[],form:ReviewForm,final:{cents:number}){
  const lines=resolvePlatformSales(session,reports,form);
  if(lines)return livePlatformCommissions(rules,lines);
  const c=reports.find(r=>r.role==='control');
  return [{platform:'',...liveComputeCommission({rules,finalSalesCents:final.cents,adSpendCents:c?.ad_spend_cents==null?null:Number(c.ad_spend_cents)})}];
}
function combinedResults(results: ReturnType<typeof commissionResults>){
  const first=results[0];
  const amount=(role:'anchor'|'control'|'operator')=>({rateUnits:results.length===1?first[role].rateUnits:0,amountCents:results.reduce((n,r)=>n+r[role].amountCents,0)});
  return {...first,finalSalesCents:results.reduce((n,r)=>n+r.finalSalesCents,0),adSpendCents:results.some(r=>r.adSpendCents===null)?null:results.reduce((n,r)=>n+(r.adSpendCents??0),0),roiScaled:results.length===1?first.roiScaled:null,belowRoi:results.some(r=>r.belowRoi),anchor:amount('anchor'),control:amount('control'),operator:amount('operator')};
}

/**
 * 运营人员由审核人最终确定：不填沿用排场/上播时填的运营；勾选「本场没有运营」则没有。
 * 运营兼任中控（同一人）时不另算运营提成；运营不能同时是主播。
 */
export async function resolveOperator(em: EntityManager, companyId: number, session: Row, form: ReviewForm) {
  const original = session.operator_user_id ? Number(session.operator_user_id) : null;
  let finalId = original;
  if (form.noOperator) finalId = null;
  else if (form.operatorUserId) finalId = Number(form.operatorUserId);
  if (finalId) {
    const [person] = await em.query("SELECT id FROM users WHERE company_id = ? AND id = ? AND status = 'active'", [companyId, finalId]);
    if (!person) liveFail('所选运营人员不存在或已停用', 400);
    if (finalId === Number(session.anchor_user_id)) liveFail('运营人员不能同时是本场主播，请重新选择或勾选「本场没有运营人员」', 400);
  }
  const control = session.control_user_id ? Number(session.control_user_id) : null;
  const doubledAsControl = !!finalId && finalId === control;
  return { original, finalId, counted: !!finalId && !doubledAsControl, doubledAsControl };
}

/**
 * 主播工资：默认取场次上播、下播时间和员工档案里的计时时薪，审核时都可以修改。
 * 时薪必填：档案里不是计时（或没有时薪）时，审核人必须填写，否则不能通过。
 */
export async function resolveWage(em: EntityManager, companyId: number, session: Row, form: ReviewForm, role: 'anchor'|'control' = 'anchor') {
  const label=role==='anchor'?'主播':'中控';
  const controlReport=role==='control'?(await reportsOf(em,companyId,Number(session.id))).find(r=>r.role==='control'):null;
  const [clock]:Row[]=session.checkin_mode?await em.query("SELECT DATE_FORMAT(start_at,'%Y-%m-%d %H:%i:%s') start_text,DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') end_text FROM live_session_checkins WHERE company_id=? AND session_id=? AND role=?",[companyId,session.id,role]):[];
  if(session.checkin_mode&&(!clock||!clock.end_text)&&!((await reportsOf(em,companyId,Number(session.id))).find(r=>r.role===role)?.manual_actor_id))liveFail(`${label}未完成本人上下播，请人事核实打卡后再核定工资`,400);
  const reportedStart: string = clock?.start_text??session.start_text, reportedEnd: string = clock?.end_text??controlReport?.end_text??session.end_text;
  if (!reportedEnd) liveFail('本场还没有下播时间，不能计算主播工资', 400);
  const pick = (value: unknown, fallback: string, label: string) => {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const t = liveToText(liveFromText(value));
    if (!t) liveFail(`${label}格式不正确`, 400);
    return t as string;
  };
  const startAt = pick((role==='anchor'?form.wageStartAt:form.controlWageStartAt), reportedStart, `${label}工资的上播时间`);
  const endAt = pick((role==='anchor'?form.wageEndAt:form.controlWageEndAt), reportedEnd, `${label}工资的下播时间`);
  const [profile]: Row[] = await em.query('SELECT pay_type, hourly_rate FROM users WHERE company_id = ? AND id = ?', [companyId, role==='anchor'?session.anchor_user_id:session.control_user_id]);
  const archiveRate = liveArchiveHourlyRate(profile ? { payType: profile.pay_type, hourlyRate: profile.hourly_rate === null ? null : Number(profile.hourly_rate) } : null);
  const inputRate=role==='anchor'?form.wageHourlyRateCents:form.controlWageHourlyRateCents;
  const typed = typeof inputRate === 'number' ? inputRate : null;
  const trialProxyAnchor = role === 'anchor' && !!Number(session.trial_proxy);
  const scheduledRate = role === 'anchor' ? session.scheduled_trial_rate : null;
  if (trialProxyAnchor && scheduledRate == null && (typed === null || !Number.isSafeInteger(typed) || typed <= 0)) {
    liveFail('请填写本场试播主播时薪，金额必须大于 0', 400);
  }
  const rate = typed ?? scheduledRate ?? archiveRate;
  if (!rate) liveFail(`请填写${label}时薪：员工档案里没有计时时薪`, 400);
  const wage = liveComputeWage({ startAt, endAt, hourlyRateCents: rate });
  return {
    ...wage, startAt, endAt, archiveRate, reportedStart, reportedEnd,
    rateSource: !trialProxyAnchor && scheduledRate == null && archiveRate !== null && wage.hourlyRateCents === archiveRate ? 'archive' : 'manual',
    note: String((role==='anchor'?form.wageNote:form.controlWageNote) || '').trim().slice(0, 500) || null,
    timesChanged: startAt !== reportedStart || endAt !== reportedEnd,
  };
}

/**
 * 审核通过：写入主播、中控、运营的提成记录和主播工资记录，并把场次标为已审核。必须在流程引擎办理审核步骤的事务内调用。
 */
export async function approveSession(em: EntityManager, ctx: { companyId: number; actorId: number; runId: number; now: Date }, sessionId: number, form: ReviewForm) {
  await lockCompany(em, ctx.companyId);
  const session = await sessionRow(em, ctx.companyId, sessionId, true);
  if (await closedDay(em, ctx.companyId, session.session_day)) liveFail('该日期已进入工资结算审批或已结算，不能再新增收入');
  if (session.status !== 'submitted' || Number(session.flow_run_id) !== ctx.runId) liveFail('场次已不在待审核状态，请刷新后核对');
  const reports = await reportsOf(em, ctx.companyId, sessionId);
  requireReports(session, reports);
  form={...form,finalSource:form.finalSource||(reports.some(r=>r.role==='operator')?'operator':reports.some(r=>r.role==='anchor')?'anchor':'control')};
  const final = resolveFinalSales(form, reports,!!session.checkin_mode);
  const versions = await ruleVersions(em, ctx.companyId);
  const version = liveVersionFor(versions, session.session_day);
  if (!version) liveFail(`没有适用于 ${session.session_day} 的提成规则版本，请先在直播管理 › 提成规则中设置`);
  const rules: LiveRules = version!.rules;
  const control = reports.find((r) => r.role === 'control');
  const adSpend = control?.ad_spend_cents === null || control?.ad_spend_cents === undefined ? null : Number(control.ad_spend_cents);
  const platforms = commissionResults(rules,session,reports,form,final);
  const result = combinedResults(platforms);
  const operator = await resolveOperator(em, ctx.companyId, session, form);
  const wage = await resolveWage(em, ctx.companyId, session, form);
  const controlAttended=!session.checkin_mode||reports.some(r=>r.role==='control');

  if(session.checkin_mode){
    if(session.orders_capture_status!=='ready')liveFail('本场订单尚未完整归集，请核对聚水潭后重试',409);
    const base=reports.find(r=>r.role===String(form.finalSource).split('_')[0]);
    const operatorBasis=form.finalSource==='operator'?await em.query('SELECT shop_id shopId,order_id orderId,refund_cents refundCents FROM live_session_order_snapshots WHERE company_id=? AND session_id=?',[ctx.companyId,sessionId]):[];
    const basis=base?.order_basis_json?(typeof base.order_basis_json==='string'?JSON.parse(base.order_basis_json):base.order_basis_json):operatorBasis;
    await em.query('UPDATE live_session_order_snapshots SET baseline_refund_cents=0 WHERE company_id=? AND session_id=?',[ctx.companyId,sessionId]);
    for(const o of basis)await em.query('UPDATE live_session_order_snapshots SET baseline_refund_cents=? WHERE company_id=? AND session_id=? AND shop_id=? AND order_id=?',[o.refundCents,ctx.companyId,sessionId,o.shopId,o.orderId]);
  }
  const commissionOnly = await commissionOnlyControl(em, ctx.companyId, session.control_user_id);
  const controlWage=session.control_user_id && controlAttended && !commissionOnly ? await resolveWage(em, ctx.companyId, session, form, 'control'):null;
  const at = wallNow(ctx.now);
  const amounts = { anchor: 0, control: 0, operator: 0 };
  const approvedLines = resolvePlatformSales(session, reports, form);
  const sourceRole = form.finalSource === 'manual' ? 'anchor' : String(form.finalSource).split('_')[0];
  const sourceLines = linesOf(reports.find(r => r.role === sourceRole) ?? {});
  const unverifiedStores = channelStores(channelsOf(session))
    .filter(store => !sourceLines.find(line => line.storeId === store.id)?.verified)
    .map(store => ({ storeId: store.id, name: store.name, platform: store.platform,
      reason: String(form.finalReason || sourceLines.find(line => line.storeId === store.id)?.reason || session.manual_reason || '').trim() }));
  for (const platform of platforms) {
    const roles: Array<['anchor' | 'control' | 'operator', number, { rateUnits: number; amountCents: number }]> = [['anchor', Number(session.anchor_user_id), platform.anchor]];
    if (session.control_user_id && controlAttended) roles.push(['control', Number(session.control_user_id), platform.control]);
    if (operator.counted) roles.push(['operator', operator.finalId!, platform.operator]);
    const snapshot = JSON.stringify({
      controlCommissionOnly: commissionOnly, versionId: version!.id, effectiveFrom: version!.effectiveFrom, rules,
      tier: platform.tier, belowRoi: platform.belowRoi, platform: platform.platform,
      unverifiedStores: unverifiedStores.filter(store => store.platform === platform.platform),
      storeLines: approvedLines?.filter(line => line.platform === platform.platform),
    });
    for (const [role, userId, value] of roles) {
      amounts[role] += value.amountCents;
      await em.query(`INSERT INTO live_commission_records(company_id,session_id,user_id,role,session_date,final_sales_cents,ad_spend_cents,roi_scaled,below_roi,rate_units,amount_cents,rule_version_id,rule_snapshot,approved_by,approved_at,flow_run_id,platform) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ctx.companyId, sessionId, userId, role, session.session_day, platform.finalSalesCents, platform.adSpendCents, platform.roiScaled, role !== 'operator' && platform.belowRoi ? 1 : 0, value.rateUnits, value.amountCents, version!.id, snapshot, ctx.actorId, at, ctx.runId, platform.platform]);
    }
  }
  const wageSnapshot = JSON.stringify({
    trialProxy: Number(session.trial_proxy)?{anchorId:Number(session.anchor_user_id),confirmedBy:Number(session.started_by)}:null,
    reportedStartAt: wage.reportedStart, reportedEndAt: wage.reportedEnd, timesChanged: wage.timesChanged, archiveHourlyRateCents: wage.archiveRate,
    operator: { originalId: operator.original, finalId: operator.finalId, counted: operator.counted, doubledAsControl: operator.doubledAsControl },
  });
  await em.query(
    `INSERT INTO live_wage_records (company_id, session_id, user_id, session_date, start_at, end_at, minutes, hourly_rate_cents, rate_source, amount_cents, adjust_note, review_snapshot,
      approved_by, approved_at, flow_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ctx.companyId, sessionId, session.anchor_user_id, session.session_day, wage.startAt, wage.endAt, wage.minutes, wage.hourlyRateCents, wage.rateSource, wage.amountCents, wage.note, wageSnapshot, ctx.actorId, at, ctx.runId],
  );
  if (controlWage) await em.query(`INSERT INTO live_wage_records (company_id,session_id,user_id,role,session_date,start_at,end_at,minutes,hourly_rate_cents,rate_source,amount_cents,adjust_note,review_snapshot,approved_by,approved_at,flow_run_id) VALUES (?,?,?,'control',?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ctx.companyId,sessionId,session.control_user_id,session.session_day,controlWage.startAt,controlWage.endAt,controlWage.minutes,controlWage.hourlyRateCents,controlWage.rateSource,controlWage.amountCents,controlWage.note,JSON.stringify({role:'control',reportedStartAt:controlWage.reportedStart,reportedEndAt:controlWage.reportedEnd,timesChanged:controlWage.timesChanged,archiveHourlyRateCents:controlWage.archiveRate}),ctx.actorId,at,ctx.runId]);
  await em.query(
    `UPDATE live_sessions SET status = 'approved', final_sales_cents = ?, final_sales_source = ?, final_sales_reason = ?, approved_by = ?, approved_at = ?, operator_user_id = ?,
      return_reason = NULL, revision = revision + 1 WHERE company_id = ? AND id = ?`,
    [result.finalSalesCents, final.source, final.reason, ctx.actorId, at, operator.finalId, ctx.companyId, sessionId],
  );
  return { finalSalesCents: result.finalSalesCents, amounts, wageCents: wage.amountCents };
}

/** 审核退回：场次回到「已退回」，主播和中控修改下播报告后可重新提交。 */
export async function returnSession(em: EntityManager, companyId: number, sessionId: number, runId: number, reason: string) {
  const session = await sessionRow(em, companyId, sessionId, true);
  if (session.status !== 'submitted' || Number(session.flow_run_id) !== runId) return;
  await em.query("UPDATE live_sessions SET status = 'returned', return_reason = ?, revision = revision + 1 WHERE company_id = ? AND id = ?", [reason.slice(0, 500), companyId, sessionId]);
}

/** 流程被拒绝或撤回：场次回到「已退回」并解除与本次流程的关联，重新提交时发起新的审核流程。 */
export async function detachSession(em: EntityManager, companyId: number, sessionId: number, runId: number, reason: string) {
  const session = await sessionRow(em, companyId, sessionId, true);
  if (session.status === 'approved' || Number(session.flow_run_id) !== runId) return;
  await em.query("UPDATE live_sessions SET status = 'returned', return_reason = ?, flow_run_id = NULL, revision = revision + 1 WHERE company_id = ? AND id = ?", [reason.slice(0, 500), companyId, sessionId]);
}

/** 审核试算：和「通过」用同一套规则算出提成与工资，但什么都不写（审核对话框随输入刷新）。 */
export async function previewApproval(em: EntityManager, companyId: number, sessionId: number, form: ReviewForm) {
  const session = await sessionRow(em, companyId, sessionId);
  const reports = await reportsOf(em, companyId, sessionId);
  form={...form,finalSource:form.finalSource||(reports.some(r=>r.role==='operator')?'operator':reports.some(r=>r.role==='anchor')?'anchor':'control')};
  const final = resolveFinalSales(form, reports,!!session.checkin_mode);
  const version = liveVersionFor(await ruleVersions(em, companyId), session.session_day);
  if (!version) liveFail(`没有适用于 ${session.session_day} 的提成规则版本，请先在直播管理 › 提成规则中设置`);
  const control = reports.find((r) => r.role === 'control');
  const adSpend = control?.ad_spend_cents === null || control?.ad_spend_cents === undefined ? null : Number(control.ad_spend_cents);
  const platforms=commissionResults(version!.rules,session,reports,form,final);
  const result=combinedResults(platforms);
  const operator = await resolveOperator(em, companyId, session, form);
  const wage = await resolveWage(em, companyId, session, form);
  return {
    platforms, storeLines:resolvePlatformSales(session,reports,form),
    finalSource: final.source, finalSalesCents: result.finalSalesCents, adSpendCents: result.adSpendCents, roiScaled: result.roiScaled, belowRoi: result.belowRoi,
    ruleVersion: { id: version!.id, effectiveFrom: version!.effectiveFrom }, tier: result.tier,
    anchor: result.anchor, control: session.control_user_id && (!session.checkin_mode||reports.some(r=>r.role==='control')) ? result.control : null, operator: operator.counted ? result.operator : null,
    operatorUserId: operator.finalId, operatorDoubledAsControl: operator.doubledAsControl,
    controlWage: session.control_user_id && (!session.checkin_mode||reports.some(r=>r.role==='control')) && !(await commissionOnlyControl(em, companyId, session.control_user_id)) ? await resolveWage(em, companyId, session, form, 'control'):null,
    wage: { startAt: wage.startAt, endAt: wage.endAt, minutes: wage.minutes, hourlyRateCents: wage.hourlyRateCents, amountCents: wage.amountCents, rateSource: wage.rateSource, archiveHourlyRateCents: wage.archiveRate },
  };
}
