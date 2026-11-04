import { EntityManager } from 'typeorm';
import { liveAddDays, liveIsDay, liveIsMonth, liveMonthBounds, liveToday } from '@kudesi/shared';
import { liveClock, liveFail, Row } from './live-core';

export function payrollPeriod(month?: string, from?: string, to?: string) {
  if (from !== undefined || to !== undefined) {
    if (!liveIsDay(from) || !liveIsDay(to) || from! > to!) liveFail('请选择有效的结算起止日期', 400);
    return { from: from!, to: to!, month: from!.slice(0, 7) };
  }
  if (!liveIsMonth(month)) liveFail('请选择结算月份', 400);
  const b = liveMonthBounds(month!);
  return { from: b.from, to: liveAddDays(b.until, -1), month: month! };
}
export const PERIOD_FROM = "COALESCE(period_from,STR_TO_DATE(CONCAT(month,'-01'),'%Y-%m-%d'))";
export const PERIOD_TO = "COALESCE(period_to,LAST_DAY(CONCAT(month,'-01')))";
export function periodOf(row: Row) {
  return payrollPeriod(
    row.month,
    row.period_from ? String(row.period_from).slice(0, 10) : undefined,
    row.period_to ? String(row.period_to).slice(0, 10) : undefined,
  );
}
export async function checkOverlap(em: EntityManager, c: number, from: string, to: string, excludeId?: number) {
  const rows: Row[] = await em.query(
    `SELECT id,status FROM live_settlements WHERE company_id=? AND status<>'voided' AND ${PERIOD_FROM}<=? AND ${PERIOD_TO}>=?${excludeId ? ' AND id<>?' : ''}`,
    [c, to, from, ...(excludeId ? [excludeId] : [])],
  );
  if (rows.length) liveFail(`所选日期与工资结算单 #${rows[0].id} 重叠，请先使用原结算单，不能重复结算`);
}
/** 外部退款查询前后、提交和审批时都用同一来源快照验证，防止期间收入变化。 */
export async function payrollSources(em: EntityManager, c: number, from: string, to: string) {
  const unfinished = await em.query(
    "SELECT id FROM live_sessions WHERE company_id=? AND session_date BETWEEN ? AND ? AND status<>'approved' LIMIT 1",
    [c, from, to],
  );
  if (unfinished.length) liveFail('结算范围内还有未审核场次，请先处理完');
  const records: Row[] = await em.query(
    `SELECT r.*,DATE_FORMAT(r.session_date,'%Y-%m-%d') day,s.report_source,s.manual_reason,s.checkin_mode,s.orders_capture_status FROM live_commission_records r JOIN live_sessions s ON s.company_id=r.company_id AND s.id=r.session_id WHERE r.company_id=? AND r.session_date BETWEEN ? AND ? ORDER BY r.id`,
    [c, from, to],
  );
  if(records.some(r=>r.checkin_mode&&r.orders_capture_status!=='ready'))liveFail('存在订单未完整归集的场次，不能发放提成');
  const wages: Row[] = await em.query(
    `SELECT *,DATE_FORMAT(session_date,'%Y-%m-%d') day FROM live_wage_records WHERE company_id=? AND session_date BETWEEN ? AND ? ORDER BY id`,
    [c, from, to],
  );
  const orders: Row[] = await em.query(
    `SELECT DISTINCT o.session_id,o.order_id,o.shop_id,o.amount_cents,o.platform FROM live_session_orders o JOIN live_sessions s ON s.company_id=o.company_id AND s.id=o.session_id WHERE o.company_id=? AND s.session_date BETWEEN ? AND ? AND s.checkin_mode=0 ORDER BY o.session_id,o.shop_id,o.order_id,o.amount_cents`,
    [c, from, to],
  );
  const captured:Row[]=await em.query(`SELECT o.session_id,o.order_id,o.shop_id,o.amount_cents,o.platform,o.baseline_refund_cents FROM live_session_order_snapshots o JOIN live_sessions s ON s.company_id=o.company_id AND s.id=o.session_id WHERE o.company_id=? AND s.session_date BETWEEN ? AND ? AND s.checkin_mode=1 AND o.paid=1 ORDER BY o.session_id,o.shop_id,o.order_id`,[c,from,to]);
  orders.push(...captured);
  const pendingDaily=await em.query("SELECT id FROM live_daily_work WHERE company_id=? AND work_date BETWEEN ? AND ? AND status IN ('working','pending','submitted','returned') LIMIT 1",[c,from,to]);
  if(pendingDaily.length)liveFail('结算范围内还有日常工作未结束或未审核，请先处理');
  const dailyWork:Row[]=await em.query("SELECT *,DATE_FORMAT(work_date,'%Y-%m-%d') day FROM live_daily_work WHERE company_id=? AND work_date BETWEEN ? AND ? AND status='approved' ORDER BY id",[c,from,to]);
  return { records, wages, orders, dailyWork };
}
export const sourcesFingerprint = (s: Awaited<ReturnType<typeof payrollSources>>) => JSON.stringify(s);


export type SettlementKind = 'wage' | 'commission' | 'mixed';
export interface SettlementScope { kind?: SettlementKind; userIds?: number[]; settlementId?: number }
export function scopeOf(row: Row): SettlementScope {
  return { kind: row.settlement_kind ?? 'mixed', userIds: typeof row.user_ids === 'string' ? JSON.parse(row.user_ids) : row.user_ids ?? [], settlementId: Number(row.id) };
}
export function commissionAvailableOn(day: string) {
  return `${liveMonthBounds(day.slice(0, 7)).until.slice(0, 7)}-10`;
}
export function assertCommissionDate(days: string[], now: Date) {
  const today = liveToday(now);
  if (days.some(day => commissionAvailableOn(day) > today)) liveFail('提成只能在所属月份的次月10日起结算，较早月份可以补结', 409);
}
/** 新单按收入来源占用；旧单的明细同样参与防重。草稿占用可通过作废释放。 */
export async function scopedPayrollSources(em: EntityManager, c: number, from: string, to: string, scope: SettlementScope) {
  const ids = [...new Set(scope.userIds ?? [])].sort((a,b)=>a-b);
  if (ids.some(id=>!Number.isSafeInteger(id)||id<1)||ids.length>100) liveFail('结算人员无效',400);
  if (ids.length) {
    const users: Row[] = await em.query(`SELECT id FROM users WHERE company_id=? AND id IN (${ids.map(()=>'?').join(',')})`, [c,...ids]);
    if(users.length!==ids.length) liveFail('结算人员不存在或不属于本公司',400);
  }
  const selected = (r: Row) => !ids.length || ids.includes(Number(r.user_id));
  const records: Row[] = await em.query(`SELECT r.*,DATE_FORMAT(r.session_date,'%Y-%m-%d') day,s.report_source,s.manual_reason,s.checkin_mode,s.orders_capture_status FROM live_commission_records r JOIN live_sessions s ON s.company_id=r.company_id AND s.id=r.session_id WHERE r.company_id=? AND r.session_date BETWEEN ? AND ? AND s.status='approved' ORDER BY r.id`,[c,from,to]);
  const wages: Row[] = await em.query(`SELECT w.*,DATE_FORMAT(w.session_date,'%Y-%m-%d') day FROM live_wage_records w JOIN live_sessions s ON s.company_id=w.company_id AND s.id=w.session_id WHERE w.company_id=? AND w.session_date BETWEEN ? AND ? AND s.status='approved' ORDER BY w.id`,[c,from,to]);
  const daily: Row[] = await em.query(`SELECT *,DATE_FORMAT(work_date,'%Y-%m-%d') day FROM live_daily_work WHERE company_id=? AND work_date BETWEEN ? AND ? AND status='approved' ORDER BY id`,[c,from,to]);
  const claims: Row[] = await em.query(`SELECT l.*,h.status FROM live_settlement_lines l JOIN live_settlements h ON h.company_id=l.company_id AND h.id=l.settlement_id WHERE l.company_id=? AND l.released_at IS NULL AND l.settlement_id<>? AND l.session_date BETWEEN ? AND ?`,[c,scope.settlementId??0,from,to]);
  const excluded: Array<{userId:number; sessionId:number|null; date:string; kind:string; reason:string; settlementId?:number}> = [];
  const take = (r: Row, kind: string, key: string) => {
    if (!selected(r)) return false;
    const claim = claims.find(l=>l[key] && Number(l[key])===Number(r.id));
    const reason = claim ? `已纳入结算单 #${claim.settlement_id}（${claim.status}）` : kind==='commission' && commissionAvailableOn(r.day)>liveToday(liveClock.now()) ? `未到可结算日期 ${commissionAvailableOn(r.day)}` : kind==='commission' && r.checkin_mode && r.orders_capture_status!=='ready' ? '订单尚未完整归集' : '';
    if(reason) excluded.push({userId:Number(r.user_id),sessionId:r.session_id?Number(r.session_id):null,date:r.day,kind,reason,...(claim?{settlementId:Number(claim.settlement_id)}:{})});
    return !reason;
  };
  const chosenRecords = scope.kind==='wage' ? [] : records.filter(r=>take(r,'commission','commission_record_id'));
  const chosenWages = scope.kind==='commission' ? [] : wages.filter(r=>take(r,'wage','wage_record_id'));
  const dailyWork = scope.kind==='commission' ? [] : daily.filter(r=>take(r,'wage','daily_work_id'));
  const pending: Row[] = await em.query(`SELECT s.id,s.anchor_user_id anchor_id,s.control_user_id control_id,s.operator_user_id operator_id,DATE_FORMAT(s.session_date,'%Y-%m-%d') day FROM live_sessions s WHERE s.company_id=? AND s.session_date BETWEEN ? AND ? AND s.status<>'approved'`,[c,from,to]);
  for(const r of pending) for(const userId of [...new Set([r.anchor_id,r.control_id,r.operator_id].filter(Boolean).map(Number))]) if(!ids.length||ids.includes(userId)) excluded.push({userId,sessionId:Number(r.id),date:r.day,kind:scope.kind??'mixed',reason:'场次尚未审核'});
  if(scope.kind!=='commission'){
    const pendingWork:Row[]=await em.query("SELECT id,user_id,DATE_FORMAT(work_date,'%Y-%m-%d') day FROM live_daily_work WHERE company_id=? AND work_date BETWEEN ? AND ? AND status IN ('working','pending','submitted','returned')",[c,from,to]);
    for(const r of pendingWork)if(selected(r))excluded.push({userId:Number(r.user_id),sessionId:null,date:r.day,kind:'wage',reason:'日常工作尚未结束或审核'});
  }
  const orders: Row[] = await em.query(`SELECT DISTINCT o.session_id,o.order_id,o.shop_id,o.amount_cents,o.platform FROM live_session_orders o JOIN live_sessions s ON s.company_id=o.company_id AND s.id=o.session_id WHERE o.company_id=? AND s.session_date BETWEEN ? AND ? AND s.checkin_mode=0 ORDER BY o.session_id,o.shop_id,o.order_id,o.amount_cents`,[c,from,to]);
  const captured: Row[] = await em.query(`SELECT o.session_id,o.order_id,o.shop_id,o.amount_cents,o.platform,o.baseline_refund_cents FROM live_session_order_snapshots o JOIN live_sessions s ON s.company_id=o.company_id AND s.id=o.session_id WHERE o.company_id=? AND s.session_date BETWEEN ? AND ? AND s.checkin_mode=1 AND o.paid=1 ORDER BY o.session_id,o.shop_id,o.order_id`,[c,from,to]);
  return {records:chosenRecords,wages:chosenWages,dailyWork,orders:[...orders,...captured].filter(o=>chosenRecords.some(r=>Number(r.session_id)===Number(o.session_id)&&(!r.platform||r.platform===o.platform))),excluded};
}
