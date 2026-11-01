import { EntityManager } from 'typeorm';
import { liveAddDays, liveIsDay, liveIsMonth, liveMonthBounds } from '@kudesi/shared';
import { liveFail, Row } from './live-core';

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
    `SELECT id,status FROM live_settlements WHERE company_id=? AND ${PERIOD_FROM}<=? AND ${PERIOD_TO}>=?${excludeId ? ' AND id<>?' : ''}`,
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
    `SELECT r.*,DATE_FORMAT(r.session_date,'%Y-%m-%d') day,s.report_source,s.manual_reason FROM live_commission_records r JOIN live_sessions s ON s.company_id=r.company_id AND s.id=r.session_id WHERE r.company_id=? AND r.session_date BETWEEN ? AND ? ORDER BY r.id`,
    [c, from, to],
  );
  const wages: Row[] = await em.query(
    `SELECT *,DATE_FORMAT(session_date,'%Y-%m-%d') day FROM live_wage_records WHERE company_id=? AND session_date BETWEEN ? AND ? ORDER BY id`,
    [c, from, to],
  );
  const orders: Row[] = await em.query(
    `SELECT DISTINCT o.session_id,o.order_id,o.shop_id,o.amount_cents FROM live_session_orders o JOIN live_sessions s ON s.company_id=o.company_id AND s.id=o.session_id WHERE o.company_id=? AND s.session_date BETWEEN ? AND ? ORDER BY o.session_id,o.shop_id,o.order_id,o.amount_cents`,
    [c, from, to],
  );
  return { records, wages, orders };
}
export const sourcesFingerprint = (s: Awaited<ReturnType<typeof payrollSources>>) => JSON.stringify(s);
