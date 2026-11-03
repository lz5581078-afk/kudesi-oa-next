import type { EntityManager } from 'typeorm';
import type { Row } from './live-core';

/** Caller holds the company/session lock. Planned people are not actual check-ins. */
export async function finishCheckedOutRoom(em: EntityManager, companyId: number, session: Row): Promise<boolean> {
  if (Number(session.checkin_mode) !== 1 || session.status !== 'live') return false;
  const clocks: Row[] = await em.query(`SELECT role,user_id,DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') end_text
    FROM live_session_checkins WHERE company_id=? AND session_id=? AND role IN ('anchor','control') FOR UPDATE`, [companyId, session.id]);
  const anchor = clocks.find(c => c.role === 'anchor' && Number(c.user_id) === Number(session.anchor_user_id));
  const control = clocks.find(c => c.role === 'control' && Number(c.user_id) === Number(session.control_user_id));
  // A real anchor check-in continues to govern the room. Without one, the actual control's checkout ends it.
  const endAt = anchor ? anchor.end_text : control?.end_text;
  if (!endAt) return false;
  await em.query("UPDATE live_sessions SET end_at=?,status='pending_report',revision=revision+1 WHERE company_id=? AND id=? AND status='live'", [endAt, companyId, session.id]);
  await em.query("UPDATE live_schedules SET status='finished' WHERE company_id=? AND session_id=? AND status='live'", [companyId, session.id]);
  return true;
}
