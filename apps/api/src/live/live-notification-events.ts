import { reportsLocked } from './live-checkin-core';
import { liveClock, type Row } from './live-core';
import { EntityManager } from 'typeorm';
import { createChecker, resolvePermissions } from '@kudesi/shared';
import { User, Position, PositionPermission, UserPermissionOverride } from '../entities';
import { writeNotification } from '../outbox/write-notification';

type Notice = { key: string; channel: 'live'|'notice'|'supervision'|'system'|'business'; title: string; body: string; link?: string; resourceId?: number };

/** Company-scoped permission resolution, including secondary positions and explicit denials. */
export async function liveRecipientAllowed(em: EntityManager, companyId: number, id: number, permission?: string) {
  const user = await em.findOne(User, { where: { companyId, id, status: 'active' } });
  if (!user) return false;
  if (!permission) return true;
  const positions = [...new Set([user.positionId, ...(user.extraPositionIds ?? [])].filter((v): v is number => !!v))];
  const rows = (await Promise.all(positions.map(async positionId => await em.findOne(Position,{where:{id:positionId,companyId}}) ? em.find(PositionPermission, { where: { positionId } }) : []))).flat();
  const overrides = await em.find(UserPermissionOverride, { where: { userId: id } });
  const check = createChecker(resolvePermissions({ isCompanyAdmin: user.isCompanyAdmin, positionPermissions: rows.map(r => r.permission), overrides }));
  return check(permission) || permission === 'features.live.view' && check('live.manage');
}

/** Dedup covers both OA and Feishu; the event and outbox roll back with the business operation. */
export async function liveNotify(em: EntityManager, companyId: number, ids: Array<number|null|undefined>, notice: Notice): Promise<void> {
  if (!em.queryRunner?.isTransactionActive) return em.transaction(tx => liveNotify(tx, companyId, ids, notice));
  const [settings] = await em.query('SELECT enabled FROM live_notification_settings WHERE company_id=?', [companyId]);
  if (settings && !settings.enabled) return;
  for (const id of new Set(ids.filter((v): v is number => Number.isSafeInteger(v) && Number(v) > 0))) {
    if (!await liveRecipientAllowed(em, companyId, id, notice.channel === 'business' ? 'features.live.view' : notice.channel === 'system' ? 'system.integrations.view' : undefined)) continue;
    const result = await em.query('INSERT IGNORE INTO live_notification_events(company_id,event_key,user_id) VALUES(?,?,?)', [companyId, notice.key, id]);
    if (!result.affectedRows) continue;
    await writeNotification(em, { companyId, userId: id, kind: 'live_notification', title: notice.title, body: notice.body, link: notice.link ?? '/features/live-desk' },
      { key: `live:${notice.key}`, channel: notice.channel, resourceType: 'live-notification', resourceId: notice.resourceId, kind: notice.channel === 'business' ? 'live-digest' : 'live-event', liveEventKey: notice.key });
  }
}

export async function liveSessionResult(em: EntityManager, companyId: number, sessionId: number, key: string, title: string, except?: number) {
  const [s] = await em.query('SELECT anchor_user_id,control_user_id,operator_user_id,room_name FROM live_sessions WHERE company_id=? AND id=?', [companyId, sessionId]);
  if (!s) return;
  await liveNotify(em, companyId, [s.anchor_user_id,s.control_user_id,s.operator_user_id].map(Number).filter(id => id !== except),
    { key, channel: 'notice', title, body: `${s.room_name}场次结果已更新，请在「我的直播」查看本人明细。`, resourceId: sessionId });
}

export async function liveHandover(em: EntityManager, companyId: number, sessionId: number) {
  const [s] = await em.query('SELECT room_id,end_at FROM live_sessions WHERE company_id=? AND id=?', [companyId,sessionId]);
  if (!s?.end_at) return;
  const [next] = await em.query(`SELECT * FROM live_schedules WHERE company_id=? AND room_id=? AND status='scheduled'
    AND end_at>=? AND start_at<=DATE_ADD(?,INTERVAL 2 HOUR) ORDER BY start_at,id LIMIT 1`, [companyId,s.room_id,s.end_at,s.end_at]);
  if (!next) return;
  await liveNotify(em,companyId,[next.anchor_user_id,next.control_user_id,next.operator_user_id].map(Number),
    {key:`handover:${sessionId}:${next.id}:${next.notification_version}`,channel:'live',title:'上一场已下播，请准备交接',body:`${next.room_name}上一场已下播，请按排场时间准备接播。`,resourceId:Number(next.id)});
}


export async function pendingCheckoutUsers(em: EntityManager, companyId: number, sessionId: number): Promise<number[]> {
  const [s]: Row[] = await em.query('SELECT status,checkin_mode,anchor_user_id,control_user_id,operator_user_id,report_locked_at,report_deadline FROM live_sessions WHERE company_id=? AND id=?',[companyId,sessionId]);
  if (!s || !['live','pending_report','returned'].includes(s.status) || reportsLocked(s,liveClock.now())) return [];
  const participants = [['anchor',s.anchor_user_id],['control',s.control_user_id],['operator',s.operator_user_id]] as const;
  if (s.checkin_mode) {
    const clocks: Row[] = await em.query('SELECT role,user_id FROM live_session_checkins WHERE company_id=? AND session_id=? AND end_at IS NULL',[companyId,sessionId]);
    return clocks.filter(c=>participants.some(([role,id])=>role===c.role && Number(id)===Number(c.user_id))).map(c=>Number(c.user_id));
  }
  const reports: Row[] = await em.query('SELECT role FROM live_session_reports WHERE company_id=? AND session_id=?',[companyId,sessionId]);
  return participants.filter(([role,id])=>id && !reports.some(r=>r.role===role)).map(([,id])=>Number(id));
}

export async function notifyCheckoutPeers(em: EntityManager, companyId: number, session: Row, reporter: {id:number;name:string}) {
  const sessionId=Number(session.id);
  const pending=await pendingCheckoutUsers(em,companyId,sessionId);
  await liveNotify(em,companyId,pending.filter(id=>id!==reporter.id),{
    key:`checkout-peer:${sessionId}:${reporter.id}`,channel:'live',resourceId:sessionId,
    title:`${reporter.name}已下播，请报下播`,
    body:`${session.room_name} · ${session.start_text.slice(0,16)} 场次。请在「我的直播」确认并提交本人的下播记录。`,
  });
}
