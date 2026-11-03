import { checkOverlap, periodOf, payrollSources } from './live-payroll-core';
import { EntityManager } from 'typeorm';
import { liveToday } from '@kudesi/shared';
import { Row, liveFail, lockCompany, wallNow } from './live-core';

export const SETTLEMENT_STATUS: Record<string, string> = { draft: '待提交', submitted: '审批中', returned: '已退回', approved: '已结算' };

export async function lockedSettlement(em: EntityManager, companyId: number, id: number): Promise<Row> {
  await lockCompany(em, companyId);
  const [row] = await em.query("SELECT *,DATE_FORMAT(period_from,'%Y-%m-%d') period_from,DATE_FORMAT(period_to,'%Y-%m-%d') period_to FROM live_settlements WHERE company_id = ? AND id = ? FOR UPDATE", [companyId, id]);
  if (!row) liveFail('结算单不存在', 404);
  return row;
}

/** 提交、审批前再核对一次：本月场次都已审核，且提成记录和结算明细一一对应（期间有变化要退回重新核对）。 */
export async function validateSettlementSources(em: EntityManager, companyId: number, row: Row) {
  const p=periodOf(row);
  await checkOverlap(em,companyId,p.from,p.to,Number(row.id));
  const sources=await payrollSources(em,companyId,p.from,p.to);
  const lines:Row[]=await em.query('SELECT * FROM live_settlement_lines WHERE company_id=? AND settlement_id=? ORDER BY commission_record_id',[companyId,row.id]);
  const commissionLines=lines.filter(l=>!l.daily_work_id);
  if(sources.records.length+sources.dailyWork.length!==Number(row.record_count)||sources.records.length!==commissionLines.length||sources.records.some((r,i)=>Number(r.id)!==Number(commissionLines[i].commission_record_id)))liveFail('本期提成记录有变化，请退回重新核对');
  const dailyLines=lines.filter(l=>l.daily_work_id);
  if(dailyLines.length!==sources.dailyWork.length||sources.dailyWork.some(w=>!dailyLines.some(l=>Number(l.daily_work_id)===Number(w.id)&&Number(l.wage_cents)===Number(w.amount_cents)&&Number(l.wage_minutes)===Number(w.approved_minutes??w.minutes)&&Number(l.user_id)===Number(w.user_id))))liveFail('本期日常工作工资有变化，请重新核对');
  if(row.period_from){
    for(const l of lines){const w=sources.wages.find(w=>Number(w.id)===Number(l.wage_record_id));if(l.wage_record_id&&(!w||Number(w.amount_cents)!==Number(l.wage_cents)||Number(w.minutes)!==Number(l.wage_minutes)))liveFail('本期计时工资有变化，请重新核对');}
    if(sources.wages.length!==lines.filter(l=>l.wage_record_id).length)liveFail('本期计时工资有变化，请重新核对');
  }
}

/** 提交审批（发起流程）后：结算单进入审批中，记录流程编号。 */
export async function markSubmitted(em: EntityManager, ctx: { companyId: number; actorId: number; now: Date }, settlementId: number, runId: number | null) {
  const row = await lockedSettlement(em, ctx.companyId, settlementId);
  if (!['draft', 'returned'].includes(row.status)) liveFail(row.status === 'approved' ? '结算单已审批通过' : '结算单正在审批中');
  await validateSettlementSources(em, ctx.companyId, row);
  await em.query(
    "UPDATE live_settlements SET status = 'submitted', return_reason = NULL, flow_run_id = COALESCE(?, flow_run_id), submitted_by = ?, submitted_at = ?, revision = revision + 1 WHERE company_id = ? AND id = ?",
    [runId, ctx.actorId, wallNow(ctx.now), ctx.companyId, settlementId],
  );
}

/** 审批办理这一步：只核对，真正锁定在整条流程完成时（管理员可能在后面加了别的审批步骤）。 */
export async function checkApprovable(em: EntityManager, companyId: number, settlementId: number, runId: number) {
  const row = await lockedSettlement(em, companyId, settlementId);
  if (row.status !== 'submitted' || Number(row.flow_run_id) !== runId) liveFail('结算单已不在审批中，请刷新后核对');
  await validateSettlementSources(em, companyId, row);
}

/** 流程全部通过：结算单锁定为已结算，只能在月份结束后完成。 */
export async function approveSettlement(em: EntityManager, ctx: { companyId: number; actorId: number; runId: number; now: Date }, settlementId: number) {
  const row = await lockedSettlement(em, ctx.companyId, settlementId);
  if (row.status !== 'submitted' || Number(row.flow_run_id) !== ctx.runId) liveFail('结算单已不在审批中，请刷新后核对');
  await validateSettlementSources(em, ctx.companyId, row);
  if (periodOf(row).to >= liveToday(ctx.now)) liveFail('只能在结算日期范围结束后完成工资结算审批');
  await em.query("UPDATE live_settlements SET status = 'approved', approved_by = ?, approved_at = ?, return_reason = NULL, revision = revision + 1 WHERE company_id = ? AND id = ?", [ctx.actorId, wallNow(ctx.now), ctx.companyId, settlementId]);
}

export async function returnSettlement(em: EntityManager, companyId: number, settlementId: number, runId: number, reason: string) {
  const row = await lockedSettlement(em, companyId, settlementId);
  if (row.status !== 'submitted' || Number(row.flow_run_id) !== runId) return;
  await em.query("UPDATE live_settlements SET status = 'returned', return_reason = ?, revision = revision + 1 WHERE company_id = ? AND id = ?", [reason.slice(0, 500), companyId, settlementId]);
}

/** 流程被拒绝或撤回：回到已退回并解除与本次流程的关联。 */
export async function detachSettlement(em: EntityManager, companyId: number, settlementId: number, runId: number, reason: string) {
  const row = await lockedSettlement(em, companyId, settlementId);
  if (row.status === 'approved' || Number(row.flow_run_id) !== runId) return;
  await em.query("UPDATE live_settlements SET status = 'returned', return_reason = ?, flow_run_id = NULL, revision = revision + 1 WHERE company_id = ? AND id = ?", [reason.slice(0, 500), companyId, settlementId]);
}
