import { verifyLiveSettlementRefunds } from './live-refund-verification';
import { liveNotify, liveSessionResult } from './live-notification-events';
import { EntityManager } from 'typeorm';
import type { FlowAdapter, StepContext } from '../flow/flow-adapters';
import { Row, can, closedDay, liveClock, liveFail, num, sessionRow, wallNow } from './live-core';
import { ReviewForm, approveSession, checkSubmittable, detachSession, returnSession } from './live-review';
import { SETTLEMENT_STATUS, approveSettlement, checkApprovable, detachSettlement, lockedSettlement, markSubmitted, returnSettlement, validateSettlementSources } from './live-settlement-core';

/**
 * 直播的两条业务流程适配器。办理人、顺序都在流程定义里（管理员配置并发布），这里只写业务规则：
 * 能不能发起、办理时写什么、退回/拒绝/撤回后业务回到什么状态。
 */

const sessionIdOf = (payload: Record<string, unknown>) => num(payload.sessionId);
const settlementIdOf = (payload: Record<string, unknown>) => num(payload.settlementId);
const isParticipant = (session: Row, userId: number) => [session.anchor_user_id, session.control_user_id].some((v) => v !== null && Number(v) === userId);

export const liveSessionReview: FlowAdapter = {
  key: 'live-session-review',
  async title(em, companyId, payload) {
    const s = await sessionRow(em, companyId, sessionIdOf(payload));
    return `${s.room_name} ${s.session_day} ${String(s.start_text).slice(11, 16)} ${s.anchor_name}直播场次审核`.slice(0, 190);
  },
  /** 发起和重新提交都走这里：本场主播/中控或有排场权限的人，场次状态和下播报告齐全，且所在月份还没结算。 */
  async validateStart({ em, user, payload }) {
    const session = await sessionRow(em, user.companyId, sessionIdOf(payload), true);
    if (!isParticipant(session, user.id) && !can(user, 'live.manage')) liveFail('只有本场主播或中控可以提交审核', 403);
    await checkSubmittable(em, user.companyId, session);
    if (await closedDay(em, user.companyId, String(session.session_day),{sessionId:Number(session.id)})) liveFail('该日期已在结算审批或已结算，不能提交审核');
  },
  async onStart({ em, user, payload, run }) {
    await em.query(
      "UPDATE live_sessions SET status = 'submitted', flow_run_id = ?, submitted_by = ?, submitted_at = ?, return_reason = NULL, revision = revision + 1 WHERE company_id = ? AND id = ?",
      [run.id, user.id, wallNow(liveClock.now()), user.companyId, sessionIdOf(payload)],
    );
  },
  async onPass(ctx: StepContext) {
    if (ctx.stepKey !== 'review') return;
    await approveSession(ctx.em, { companyId: ctx.run.companyId, actorId: ctx.user.id, runId: ctx.run.id, now: liveClock.now() }, sessionIdOf(ctx.payload), ctx.form as ReviewForm);
    await liveSessionResult(ctx.em,ctx.run.companyId,sessionIdOf(ctx.payload),`approved:${ctx.run.id}`,'直播场次审核已通过',ctx.run.requesterId);
  },
  async onReturn(ctx, { reason, toSubmit }) {
    if (toSubmit) {
      await returnSession(ctx.em, ctx.run.companyId, sessionIdOf(ctx.payload), ctx.run.id, reason);
      await liveSessionResult(ctx.em,ctx.run.companyId,sessionIdOf(ctx.payload),`returned:${ctx.run.id}:${ctx.run.revision}`,'直播场次审核已退回，请核对本人报告',ctx.run.requesterId);
    }
  },
  /** 退回后由本场主播或中控任一人重新提交（不一定是第一次提交的人）。 */
  async canResubmit({ em, user, run }) {
    const session = await sessionRow(em, run.companyId, sessionIdOf(run.payload));
    return isParticipant(session, user.id) || can(user, 'live.manage');
  },
  async onResubmit(ctx) {
    await ctx.em.query(
      "UPDATE live_sessions SET status = 'submitted', return_reason = NULL, flow_run_id = ?, submitted_by = ?, submitted_at = ?, revision = revision + 1 WHERE company_id = ? AND id = ?",
      [ctx.run.id, ctx.user.id, wallNow(liveClock.now()), ctx.run.companyId, sessionIdOf(ctx.payload)],
    );
  },
  async onFinish(ctx, outcome) {
    if (outcome === 'completed') return;
    await detachSession(ctx.em, ctx.run.companyId, sessionIdOf(ctx.payload), ctx.run.id, ctx.reason || (outcome === 'rejected' ? '审核被拒绝' : '审核已撤回'));
  },
};

export const liveSettlement: FlowAdapter = {
  key: 'live-settlement',
  async title(em: EntityManager, companyId, payload) {
    const [row] = await em.query(`SELECT month,DATE_FORMAT(period_from,'%Y-%m-%d') period_from,DATE_FORMAT(period_to,'%Y-%m-%d') period_to,settlement_kind,payable_total_cents FROM live_settlements WHERE company_id = ? AND id = ?`, [companyId, settlementIdOf(payload)]);
    if (!row) liveFail('结算单不存在', 404);
    return `${row.period_from??row.month} 至 ${row.period_to??row.month} 直播${row.settlement_kind==='commission'?'提成结算':row.settlement_kind==='adjustment'?'补扣款调整':'工资结算'}（应发 ${(Number(row.payable_total_cents) / 100).toFixed(2)} 元）`.slice(0, 190);
  },
  async validateStart({ em, user, payload }) {
    if (!can(user, 'live.manage')) liveFail('没有提交月结审批的权限', 403);
    const row = await lockedSettlement(em, user.companyId, settlementIdOf(payload));
    if(Number(payload.settlementRevision)!==Number(row.revision))liveFail('结算单已重新核对，请刷新确认最新金额后提交',409);
    if (!['draft', 'returned'].includes(row.status)) liveFail(row.status === 'approved' ? '结算单已审批通过' : `结算单${SETTLEMENT_STATUS[row.status] ?? ''}，不能重复提交`);
    await validateSettlementSources(em, user.companyId, row);
  },
  async onStart({ em, user, payload, run }) {
    await markSubmitted(em, { companyId: user.companyId, actorId: user.id, now: liveClock.now() }, settlementIdOf(payload), run.id);
  },
  async onPass(ctx) {
    if (ctx.stepKey === 'approve') await verifyLiveSettlementRefunds(ctx.em,ctx.liveOrders,ctx.run.companyId,settlementIdOf(ctx.payload));
    if (ctx.stepKey === 'approve') await checkApprovable(ctx.em, ctx.run.companyId, settlementIdOf(ctx.payload), ctx.run.id);
  },
  async onReturn(ctx, { reason, toSubmit }) {
    if (toSubmit) await returnSettlement(ctx.em, ctx.run.companyId, settlementIdOf(ctx.payload), ctx.run.id, reason);
  },
  async canResubmit({ user }) { return can(user, 'live.manage'); },
  async onResubmit(ctx) {
    await markSubmitted(ctx.em, { companyId: ctx.run.companyId, actorId: ctx.user.id, now: liveClock.now() }, settlementIdOf(ctx.payload), ctx.run.id);
  },
  async onFinish(ctx, outcome) {
    const id = settlementIdOf(ctx.payload);
    if (outcome === 'completed') {
      await verifyLiveSettlementRefunds(ctx.em,ctx.liveOrders,ctx.run.companyId,id);
      await approveSettlement(ctx.em, { companyId: ctx.run.companyId, actorId: ctx.user.id, runId: ctx.run.id, now: liveClock.now() }, id);
      const people: Row[] = await ctx.em.query('SELECT DISTINCT user_id FROM live_settlement_lines WHERE company_id=? AND settlement_id=?',[ctx.run.companyId,id]);
      await liveNotify(ctx.em,ctx.run.companyId,people.map(p=>Number(p.user_id)),{key:`settled:${id}`,channel:'notice',title:'直播工资结算已确认',body:'本期直播结算已审批确认，请在「我的直播」查看本人明细。结算确认不代表已发放。',resourceId:id});
    }
    else await detachSettlement(ctx.em, ctx.run.companyId, id, ctx.run.id, ctx.reason || (outcome === 'rejected' ? '审批被拒绝' : '审批已撤回'));
  },
};
