import { EntityManager } from 'typeorm';
import { liveFromText } from '@kudesi/shared';
import { liveManagementRecipients } from './live-management-recipients';
import { liveNotify } from './live-notification-events';

/** Opening notifications already target both departments directly. */
export async function liveStartRecipients(em:EntityManager,companyId:number):Promise<number[]> {
  const {hr,management}=await liveManagementRecipients(em,companyId);
  return [...new Set([...hr,...management])];
}

async function startDeviation(em: EntityManager, companyId: number, sessionId: number) {
  const [s] = await em.query(`SELECT s.room_name, a.name anchor_name, c.name control_name, o.name operator_name,
    DATE_FORMAT(s.start_at,'%Y-%m-%d %H:%i:%s') actual_start, DATE_FORMAT(p.start_at,'%Y-%m-%d %H:%i:%s') planned_start
    FROM live_sessions s JOIN live_schedules p ON p.company_id=s.company_id AND p.id=s.schedule_id
    LEFT JOIN users a ON a.company_id=s.company_id AND a.id=s.anchor_user_id
    LEFT JOIN users c ON c.company_id=s.company_id AND c.id=s.control_user_id
    LEFT JOIN users o ON o.company_id=s.company_id AND o.id=s.operator_user_id
    WHERE s.company_id=? AND s.id=?`, [companyId, sessionId]);
  if (!s) return null;
  const actual = liveFromText(s.actual_start), planned = liveFromText(s.planned_start);
  if (!actual || !planned) return null;
  const seconds = (+actual - +planned) / 1000;
  return Math.abs(seconds) > 300 ? { ...s, seconds } : null;
}

export async function liveStartNoticeValid(em: EntityManager, companyId: number, userId: number, sessionId: number) {
  return !!await startDeviation(em, companyId, sessionId) && (await liveStartRecipients(em, companyId)).includes(userId);
}

/** Called in the start transaction. No external delivery or historical replay here. */
export async function liveStartNotification(em: EntityManager, companyId: number, sessionId: number): Promise<void> {
  if (!em.queryRunner?.isTransactionActive) return em.transaction(tx => liveStartNotification(tx, companyId, sessionId));
  const s = await startDeviation(em, companyId, sessionId);
  if (!s) return;
  const seconds = Math.abs(s.seconds), direction = s.seconds < 0 ? '提前' : '推迟';
  await liveNotify(em, companyId, await liveStartRecipients(em, companyId), {
    key: `start-deviation:${sessionId}`, channel: 'supervision', title: `开播时间异常：${direction}超过5分钟`,
    body: `${s.room_name} · 场次${sessionId}\n主播：${s.anchor_name ?? '未安排'}；中控：${s.control_name ?? '未安排'}；运营：${s.operator_name ?? '未安排'}\n排班开始：${s.planned_start}\n实际开播：${s.actual_start}\n${direction}${Math.floor(seconds / 60)}分${seconds % 60}秒，请人事部门和总经办核实。`,
    link: '/features/live', resourceId: sessionId,
  });
}

/** Every newly started session, including unscheduled sessions. Deduplication is session/user scoped. */
export async function liveStartedNotification(em: EntityManager, companyId: number, sessionId: number): Promise<void> {
  if (!em.queryRunner?.isTransactionActive) return em.transaction(tx => liveStartedNotification(tx, companyId, sessionId));
  const [s] = await em.query(`SELECT s.room_name,DATE_FORMAT(s.start_at,'%Y-%m-%d %H:%i:%s') actual_start,
    a.name anchor_name,c.name control_name,o.name operator_name
    FROM live_sessions s
    LEFT JOIN users a ON a.company_id=s.company_id AND a.id=s.anchor_user_id
    LEFT JOIN users c ON c.company_id=s.company_id AND c.id=s.control_user_id
    LEFT JOIN users o ON o.company_id=s.company_id AND o.id=s.operator_user_id
    WHERE s.company_id=? AND s.id=?`,[companyId,sessionId]);
  if (!s) return;
  await liveNotify(em,companyId,await liveStartRecipients(em,companyId),{
    key:`started:${sessionId}`,channel:'live',title:`${s.room_name}已上播`,
    body:`${s.room_name} · 场次${sessionId}\n主播：${s.anchor_name ?? '未安排'}；中控：${s.control_name ?? '未安排'}；运营：${s.operator_name ?? '未安排'}\n实际开播：${s.actual_start}`,
    link:'/features/live',resourceId:sessionId,
  });
}

export async function liveStartedNoticeValid(em: EntityManager, companyId: number, userId: number, sessionId: number) {
  const [s]=await em.query('SELECT id FROM live_sessions WHERE company_id=? AND id=?',[companyId,sessionId]);
  return !!s && (await liveStartRecipients(em,companyId)).includes(userId);
}
