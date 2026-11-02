import { EntityManager } from 'typeorm';
import { liveClock, wallNow } from './live-core';
import { liveNotify } from './live-notification-events';
import { liveStartRecipients } from './live-start-notification';

async function overdueSchedule(em: EntityManager, companyId: number, scheduleId: number, now: Date) {
  const [s] = await em.query(`SELECT p.room_name,p.notification_version,
    DATE_FORMAT(p.start_at,'%Y-%m-%d %H:%i:%s') planned_start,
    a.name anchor_name,c.name control_name,o.name operator_name
    FROM live_schedules p
    LEFT JOIN users a ON a.company_id=p.company_id AND a.id=p.anchor_user_id
    LEFT JOIN users c ON c.company_id=p.company_id AND c.id=p.control_user_id
    LEFT JOIN users o ON o.company_id=p.company_id AND o.id=p.operator_user_id
    WHERE p.company_id=? AND p.id=? AND p.status='scheduled' AND p.session_id IS NULL
    AND p.start_at<=DATE_SUB(?,INTERVAL 10 MINUTE)
    AND NOT EXISTS(SELECT 1 FROM live_sessions s WHERE s.company_id=p.company_id AND s.schedule_id=p.id)`,
    [companyId,scheduleId,wallNow(now)]);
  return s ?? null;
}

export async function liveNoStartNoticeValid(em: EntityManager, companyId: number, userId: number, scheduleId: number, version: number) {
  const s = await overdueSchedule(em, companyId, scheduleId, liveClock.now());
  return !!s && Number(s.notification_version) === version && (await liveStartRecipients(em, companyId)).includes(userId);
}

/** Scanner holds the company lock. Notification and outbox share its transaction. */
export async function liveNoStartNotification(em: EntityManager, companyId: number, scheduleId: number, now: Date): Promise<void> {
  if (!em.queryRunner?.isTransactionActive) return em.transaction(tx => liveNoStartNotification(tx, companyId, scheduleId, now));
  const s = await overdueSchedule(em, companyId, scheduleId, now);
  if (!s) return;
  await liveNotify(em,companyId,await liveStartRecipients(em,companyId),{
    key:`no-start:${scheduleId}:${s.notification_version}`,channel:'supervision',
    title:'排班开始已满10分钟，仍未登记上播',
    body:`${s.room_name} · 排场${scheduleId}\n主播：${s.anchor_name ?? '未安排'}；中控：${s.control_name ?? '未安排'}；运营：${s.operator_name ?? '未安排'}\n排班开始：${s.planned_start}\n核对时间：${wallNow(now)}\n仍未登记上播，请人事部门和总经办核实。`,
    link:'/features/live',resourceId:scheduleId,
  });
}
