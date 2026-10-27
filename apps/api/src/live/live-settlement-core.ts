import { EntityManager } from 'typeorm';
import { liveToday } from '@kudesi/shared';
import { Row, liveFail, lockCompany, wallNow } from './live-core';

export const SETTLEMENT_STATUS: Record<string, string> = { draft: '待提交', submitted: '审批中', returned: '已退回', approved: '已结算' };

export async function lockedSettlement(em: EntityManager, companyId: number, id: number): Promise<Row> {
  await lockCompany(em, companyId);
  const [row] = await em.query('SELECT * FROM live_settlements WHERE company_id = ? AND id = ? FOR UPDATE', [companyId, id]);
  if (!row) liveFail('结算单不存在', 404);
  return row;
}

/** 提交、审批前再核对一次：本月场次都已审核，且提成记录和结算明细一一对应（期间有变化要退回重新核对）。 */
export async function validateSettlementSources(em: EntityManager, companyId: number, row: Row) {
  const unfinished = await em.query("SELECT id FROM live_sessions WHERE company_id = ? AND DATE_FORMAT(session_date,'%Y-%m') = ? AND status <> 'approved' LIMIT 1", [companyId, row.month]);
  if (unfinished.length) liveFail('本月还有未审核场次，请退回重新核对');
  const records: Row[] = await em.query("SELECT id FROM live_commission_records WHERE company_id = ? AND DATE_FORMAT(session_date,'%Y-%m') = ? ORDER BY id", [companyId, row.month]);
  const lines: Row[] = await em.query('SELECT commission_record_id FROM live_settlement_lines WHERE company_id = ? AND settlement_id = ? ORDER BY commission_record_id', [companyId, row.id]);
  if (records.length !== Number(row.record_count) || records.length !== lines.length || records.some((r, i) => Number(r.id) !== Number(lines[i].commission_record_id))) liveFail('本月提成记录或结算明细有变化，请退回重新核对');
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
  if (row.month >= liveToday(ctx.now).slice(0, 7)) liveFail('只能在月份结束后完成月底结算审批');
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
