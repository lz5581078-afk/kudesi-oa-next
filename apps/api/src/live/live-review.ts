import { EntityManager } from 'typeorm';
import {
  LIVE_FINAL_SOURCES, liveArchiveHourlyRate, liveComputeCommission, liveComputeWage, liveFromText, liveMissingReporter, liveToText, liveVersionFor,
  type LiveRules,
} from '@kudesi/shared';
import { Row, closedMonth, liveFail, lockCompany, reportsOf, ruleVersions, sessionRow, wallNow } from './live-core';

/** 主播和本场中控必须各自本人报下播；运营选填，不能以缺报说明跳过。 */
export function requireReports(session: Row, reports: Row[]) {
  const missing = liveMissingReporter(
    reports.map((r) => ({ role: String(r.role), reporterId: Number(r.reporter_user_id) })),
    { anchorId: Number(session.anchor_user_id), controlId: session.control_user_id ? Number(session.control_user_id) : null },
  );
  if (missing === 'anchor') liveFail('主播还没有报下播（须本人填报），请主播本人填报后再提交', 400);
  if (missing === 'control') liveFail('中控还没有报下播（须本人填报），请中控本人填报后再提交', 400);
}

/** 能不能提交审核：状态对、两人都本人报过。 */
export async function checkSubmittable(em: EntityManager, companyId: number, session: Row) {
  if (!['pending_report', 'returned'].includes(session.status)) liveFail(session.status === 'live' ? '还没有人报下播，请先报下播' : '场次当前状态不能提交审核');
  requireReports(session, await reportsOf(em, companyId, Number(session.id)));
}

/** 审核表单（流程步骤表单）里的字段。 */
export interface ReviewForm {
  finalSource?: string; finalSalesCents?: number; finalReason?: string;
  operatorUserId?: number; noOperator?: boolean;
  wageStartAt?: string; wageEndAt?: string; wageHourlyRateCents?: number; wageNote?: string;
}

/** 审核人选择的最终销售额：选其中一个上报值，或手填并写原因。 */
export function resolveFinalSales(form: ReviewForm, reports: Row[]): { source: string; cents: number; reason: string | null } {
  const source = String(form.finalSource || '');
  if (!LIVE_FINAL_SOURCES[source]) liveFail('请选择本场最终销售额的来源', 400);
  if (source === 'manual') {
    if (typeof form.finalSalesCents !== 'number' || form.finalSalesCents < 0) liveFail('请填写手填的最终销售额', 400);
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
export async function resolveWage(em: EntityManager, companyId: number, session: Row, form: ReviewForm) {
  const reportedStart: string = session.start_text, reportedEnd: string = session.end_text;
  if (!reportedEnd) liveFail('本场还没有下播时间，不能计算主播工资', 400);
  const pick = (value: unknown, fallback: string, label: string) => {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const t = liveToText(liveFromText(value));
    if (!t) liveFail(`${label}格式不正确`, 400);
    return t as string;
  };
  const startAt = pick(form.wageStartAt, reportedStart, '主播工资的上播时间');
  const endAt = pick(form.wageEndAt, reportedEnd, '主播工资的下播时间');
  const [profile]: Row[] = await em.query('SELECT pay_type, hourly_rate FROM users WHERE company_id = ? AND id = ?', [companyId, session.anchor_user_id]);
  const archiveRate = liveArchiveHourlyRate(profile ? { payType: profile.pay_type, hourlyRate: profile.hourly_rate === null ? null : Number(profile.hourly_rate) } : null);
  const typed = typeof form.wageHourlyRateCents === 'number' ? form.wageHourlyRateCents : null;
  const rate = typed ?? archiveRate;
  if (!rate) liveFail('请填写主播时薪：这位主播的员工档案里没有计时时薪', 400);
  const wage = liveComputeWage({ startAt, endAt, hourlyRateCents: rate });
  return {
    ...wage, startAt, endAt, archiveRate, reportedStart, reportedEnd,
    rateSource: archiveRate !== null && wage.hourlyRateCents === archiveRate ? 'archive' : 'manual',
    note: String(form.wageNote || '').trim().slice(0, 500) || null,
    timesChanged: startAt !== reportedStart || endAt !== reportedEnd,
  };
}

/**
 * 审核通过：写入主播、中控、运营的提成记录和主播工资记录，并把场次标为已审核。必须在流程引擎办理审核步骤的事务内调用。
 */
export async function approveSession(em: EntityManager, ctx: { companyId: number; actorId: number; runId: number; now: Date }, sessionId: number, form: ReviewForm) {
  await lockCompany(em, ctx.companyId);
  const session = await sessionRow(em, ctx.companyId, sessionId, true);
  if (await closedMonth(em, ctx.companyId, session.session_day.slice(0, 7), true)) liveFail('本月已进入结算审批或已结算，不能再新增提成，请先核对月结状态');
  if (session.status !== 'submitted' || Number(session.flow_run_id) !== ctx.runId) liveFail('场次已不在待审核状态，请刷新后核对');
  const reports = await reportsOf(em, ctx.companyId, sessionId);
  requireReports(session, reports);
  const final = resolveFinalSales(form, reports);
  const versions = await ruleVersions(em, ctx.companyId);
  const version = liveVersionFor(versions, session.session_day);
  if (!version) liveFail(`没有适用于 ${session.session_day} 的提成规则版本，请先在直播管理 › 提成规则中设置`);
  const rules: LiveRules = version!.rules;
  const control = reports.find((r) => r.role === 'control');
  const adSpend = control?.ad_spend_cents === null || control?.ad_spend_cents === undefined ? null : Number(control.ad_spend_cents);
  const result = liveComputeCommission({ rules, finalSalesCents: final.cents, adSpendCents: adSpend });
  const operator = await resolveOperator(em, ctx.companyId, session, form);
  const wage = await resolveWage(em, ctx.companyId, session, form);
  const at = wallNow(ctx.now);
  const roles: Array<['anchor' | 'control' | 'operator', number, { rateUnits: number; amountCents: number }]> = [['anchor', Number(session.anchor_user_id), result.anchor]];
  if (session.control_user_id) roles.push(['control', Number(session.control_user_id), result.control]);
  if (operator.counted) roles.push(['operator', operator.finalId as number, result.operator]);
  const snapshot = JSON.stringify({ versionId: version!.id, effectiveFrom: version!.effectiveFrom, rules, tier: result.tier, belowRoi: result.belowRoi });
  for (const [role, userId, value] of roles) {
    await em.query(
      `INSERT INTO live_commission_records (company_id, session_id, user_id, role, session_date, final_sales_cents, ad_spend_cents, roi_scaled, below_roi, rate_units, amount_cents,
        rule_version_id, rule_snapshot, approved_by, approved_at, flow_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      // below_roi 表示「投产不足已按规则扣减」；运营提成是固定比例、不做扣减，所以运营记录不带这个标记
      [ctx.companyId, sessionId, userId, role, session.session_day, result.finalSalesCents, result.adSpendCents, result.roiScaled, role !== 'operator' && result.belowRoi ? 1 : 0,
        value.rateUnits, value.amountCents, version!.id, snapshot, ctx.actorId, at, ctx.runId],
    );
  }
  const wageSnapshot = JSON.stringify({
    reportedStartAt: wage.reportedStart, reportedEndAt: wage.reportedEnd, timesChanged: wage.timesChanged, archiveHourlyRateCents: wage.archiveRate,
    operator: { originalId: operator.original, finalId: operator.finalId, counted: operator.counted, doubledAsControl: operator.doubledAsControl },
  });
  await em.query(
    `INSERT INTO live_wage_records (company_id, session_id, user_id, session_date, start_at, end_at, minutes, hourly_rate_cents, rate_source, amount_cents, adjust_note, review_snapshot,
      approved_by, approved_at, flow_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ctx.companyId, sessionId, session.anchor_user_id, session.session_day, wage.startAt, wage.endAt, wage.minutes, wage.hourlyRateCents, wage.rateSource, wage.amountCents, wage.note, wageSnapshot, ctx.actorId, at, ctx.runId],
  );
  await em.query(
    `UPDATE live_sessions SET status = 'approved', final_sales_cents = ?, final_sales_source = ?, final_sales_reason = ?, approved_by = ?, approved_at = ?, operator_user_id = ?,
      return_reason = NULL, revision = revision + 1 WHERE company_id = ? AND id = ?`,
    [result.finalSalesCents, final.source, final.reason, ctx.actorId, at, operator.finalId, ctx.companyId, sessionId],
  );
  return { finalSalesCents: result.finalSalesCents, amounts: Object.fromEntries(roles.map(([r, , v]) => [r, v.amountCents])), wageCents: wage.amountCents };
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
  const final = resolveFinalSales(form, reports);
  const version = liveVersionFor(await ruleVersions(em, companyId), session.session_day);
  if (!version) liveFail(`没有适用于 ${session.session_day} 的提成规则版本，请先在直播管理 › 提成规则中设置`);
  const control = reports.find((r) => r.role === 'control');
  const adSpend = control?.ad_spend_cents === null || control?.ad_spend_cents === undefined ? null : Number(control.ad_spend_cents);
  const result = liveComputeCommission({ rules: version!.rules, finalSalesCents: final.cents, adSpendCents: adSpend });
  const operator = await resolveOperator(em, companyId, session, form);
  const wage = await resolveWage(em, companyId, session, form);
  return {
    finalSource: final.source, finalSalesCents: result.finalSalesCents, adSpendCents: result.adSpendCents, roiScaled: result.roiScaled, belowRoi: result.belowRoi,
    ruleVersion: { id: version!.id, effectiveFrom: version!.effectiveFrom }, tier: result.tier,
    anchor: result.anchor, control: session.control_user_id ? result.control : null, operator: operator.counted ? result.operator : null,
    operatorUserId: operator.finalId, operatorDoubledAsControl: operator.doubledAsControl,
    wage: { startAt: wage.startAt, endAt: wage.endAt, minutes: wage.minutes, hourlyRateCents: wage.hourlyRateCents, amountCents: wage.amountCents, rateSource: wage.rateSource, archiveHourlyRateCents: wage.archiveRate },
  };
}
