import { EntityManager } from 'typeorm';
import { liveFromText } from '@kudesi/shared';
import { Department, Position, User } from '../entities';
import { liveNotify } from './live-notification-events';

const DEPARTMENTS = new Set(['人事部', '人事综合部', '人力资源部', '总经办', '总经办部门', '总经理办公室', 'A总经理', '总经理', '总经理部', '总经理部门']);
/** Resolve active staff by their department or active primary/secondary position, within this company. */
export async function liveStartRecipients(em: EntityManager, companyId: number): Promise<number[]> {
  const departments = await em.find(Department, { where: { companyId, status: 'active' } });
  const ids = new Set(departments.filter(d => DEPARTMENTS.has(d.name.trim())).map(d => d.id));
  let size = -1;
  while (size !== ids.size) {
    size = ids.size;
    for (const d of departments) if (d.parentId && ids.has(d.parentId)) ids.add(d.id);
  }
  if (!ids.size) return [];
  const positions = new Set((await em.find(Position, { where: { companyId, status: 'active' } })).filter(p => p.departmentId && ids.has(p.departmentId)).map(p => p.id));
  return (await em.find(User, { where: { companyId, status: 'active' } }))
    .filter(u => u.departmentId && ids.has(u.departmentId) || [u.positionId, ...(u.extraPositionIds ?? [])].some(id => id != null && positions.has(id)))
    .map(u => u.id);
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
