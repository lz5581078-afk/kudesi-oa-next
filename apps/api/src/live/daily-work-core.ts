import { EntityManager } from 'typeorm';
import { liveFromText, liveToText } from '@kudesi/shared';
import { liveFail, lockCompany, Row } from './live-core';
export const DAILY_LABELS: Record<string, string> = {
  scheduled: '待开始',
  working: '工作中',
  pending: '待提交审核',
  submitted: '待审核',
  approved: '已审核',
  returned: '已退回',
  cancelled: '已取消',
};
export const dailySelect = `SELECT w.*,u.name user_name,u.hourly_rate current_hourly_rate,u.pay_type current_pay_type,DATE_FORMAT(work_date,'%Y-%m-%d') day,
 DATE_FORMAT(planned_start,'%Y-%m-%d %H:%i:%s') planned_start_text,DATE_FORMAT(planned_end,'%Y-%m-%d %H:%i:%s') planned_end_text,
 DATE_FORMAT(actual_start,'%Y-%m-%d %H:%i:%s') actual_start_text,DATE_FORMAT(actual_end,'%Y-%m-%d %H:%i:%s') actual_end_text
 FROM live_daily_work w JOIN users u ON u.company_id=w.company_id AND u.id=w.user_id`;
export async function dailyRow(
  em: EntityManager,
  c: number,
  id: number,
  lock = false,
): Promise<Row> {
  if (lock) await lockCompany(em, c);
  const [r] = await em.query(
    `${dailySelect} WHERE w.company_id=? AND w.id=?${lock ? ' FOR UPDATE' : ''}`,
    [c, id],
  );
  if (!r) liveFail('日常工作排班不存在', 404);
  return r;
}
export function dailyDto(r: Row, money: boolean, now: Date) {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    name: r.user_name,
    role: r.role,
    date: r.day,
    content: r.content,
    status: r.status,
    statusLabel: DAILY_LABELS[r.status] ?? r.status,
    plannedStart: r.planned_start_text,
    plannedEnd: r.planned_end_text,
    startAt: r.actual_start_text,
    endAt: r.actual_end_text,
    report: r.report,
    returnReason: r.return_reason,
    flowRunId: r.flow_run_id ? Number(r.flow_run_id) : null,
    elapsedMinutes: r.actual_start_text
      ? Math.max(
          0,
          Math.round(
            (+(r.actual_end_text ? liveFromText(r.actual_end_text)! : now) -
              +liveFromText(r.actual_start_text)!) /
              60000,
          ),
        )
      : 0,
    minutes: r.minutes == null ? null : Number(r.approved_minutes ?? r.minutes),
    actualMinutes: r.minutes == null ? null : Number(r.minutes),
    reviewNote: r.review_note,
    hourlyRateCents:
      money && (r.hourly_rate_cents != null || r.current_pay_type === 'hourly')
        ? Number(r.hourly_rate_cents ?? r.current_hourly_rate)
        : null,
    amountCents:
      money && r.amount_cents != null ? Number(r.amount_cents) : null,
    canStart:
      r.status === 'scheduled' &&
      +now >= +liveFromText(r.planned_start_text)! &&
      +now < +liveFromText(r.planned_end_text)!,
    overdue:
      r.status === 'working' &&
      +now > +liveFromText(r.planned_end_text)! + 3600000,
  };
}
export async function assertNoDailyWork(
  em: EntityManager,
  c: number,
  ids: number[],
  start: string,
  end?: string,
) {
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(',');
  const [busy] = await em.query(
    `SELECT id FROM live_daily_work WHERE company_id=? AND user_id IN (${marks}) AND ${end ? "status NOT IN ('cancelled') AND planned_start<? AND planned_end>?" : "status='working'"} LIMIT 1`,
    [c, ...ids, ...(end ? [end, start] : [])],
  );
  if (busy)
    liveFail(
      end
        ? '人员在该时间已有日常工作排班'
        : '请先结束本人的日常工作，再开始直播',
    );
}
export function dailyTime(value: string) {
  const d = liveFromText(value);
  if (!d) liveFail('请填写有效的北京时间', 400);
  return liveToText(d)!;
}

/** 人工修正直播计薪时间也不能与已打卡的日常工作重叠。调用方持有公司锁。 */
export async function assertNoDailyPaidOverlap(
  em: EntityManager,
  c: number,
  userId: number,
  start: string,
  end: string,
) {
  const [overlap] = await em.query(
    "SELECT id FROM live_daily_work WHERE company_id=? AND user_id=? AND actual_start<? AND (actual_end>? OR actual_end IS NULL) AND status NOT IN ('scheduled','cancelled') AND NOT(status='approved' AND amount_cents=0) LIMIT 1",
    [c, userId, end, start],
  );
  if (overlap) liveFail('工资时间与日常工作记录重叠，请先核对，不能重复计薪');
}
export async function assertNoLivePaidOverlap(
  em: EntityManager,
  c: number,
  userId: number,
  start: string,
  end: string,
) {
  const [overlap] = await em.query(
    'SELECT id FROM live_wage_records WHERE company_id=? AND user_id=? AND start_at<? AND end_at>? AND amount_cents>0 LIMIT 1',
    [c, userId, end, start],
  );
  if (overlap)
    liveFail('日常工作与已审核直播工资时间重叠，请先核对，不能重复计薪');
}
