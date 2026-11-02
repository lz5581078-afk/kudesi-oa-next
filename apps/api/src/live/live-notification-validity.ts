import { liveNoStartNoticeValid } from './live-no-start-notification';
import { liveStartNoticeValid, liveStartedNoticeValid } from './live-start-notification';
import { EntityManager } from 'typeorm';
import { liveRecipientAllowed } from './live-notification-events';

/** Recheck queued alerts after recovery, schedule changes, recipient removal or permission revocation. */
export async function liveNoticeValid(em:EntityManager,companyId:number,userId:number,key:string):Promise<boolean> {
  const [cfg]=await em.query('SELECT * FROM live_notification_settings WHERE company_id=?',[companyId]);
  if(cfg&&!cfg.enabled)return false;
  const list=(v:unknown):number[]=>{try{return (typeof v==='string'?JSON.parse(v):v) as number[]??[];}catch{return [];}};
  const parts=key.split(':'),kind=parts[0],id=Number(parts[1]);
  if(kind==='no-start') return liveNoStartNoticeValid(em,companyId,userId,id,Number(parts[2]));
  if(kind==='started') return liveStartedNoticeValid(em,companyId,userId,id);
  if(kind==='start-deviation') return liveStartNoticeValid(em,companyId,userId,id);
  if(kind==='digest'||kind==='health'||kind==='expiry') {
    const business=kind==='digest';
    if(!cfg||business&&!cfg.digest_enabled||!list(business?cfg.business_recipients:cfg.system_recipients).includes(userId))return false;
    if(!await liveRecipientAllowed(em,companyId,userId,business?'features.live.view':'system.integrations.view'))return false;
    if(kind==='health') {
      const [r]=await em.query('SELECT failures FROM live_notification_health WHERE company_id=? AND health_key=?',[companyId,parts.slice(1,-1).join(':')]);
      return Number(r?.failures)>=3;
    }
    if(kind==='expiry') {
      const [r]=await em.query("SELECT data FROM resource_records WHERE company_id=? AND id=? AND type='stores' AND status='normal'",[companyId,id]);
      const data=typeof r?.data==='string'?JSON.parse(r.data):r?.data;
      return !!data?.jushuitanShopId&&data.jushuitanExpiryStatus==='dated'&&data.jushuitanExpireAt===parts[2];
    }
    return true;
  }
  if(kind==='late'||kind==='handover') {
    const scheduleId=kind==='late'?id:Number(parts[2]);
    const version=Number(parts[kind==='late'?2:3]);
    const [s]=await em.query("SELECT status,notification_version FROM live_schedules WHERE company_id=? AND id=?",[companyId,scheduleId]);
    return s?.status==='scheduled'&&Number(s.notification_version)===version;
  }
  if(kind==='report'||kind==='overrun') {
    const [s]=await em.query('SELECT status,anchor_user_id,control_user_id FROM live_sessions WHERE company_id=? AND id=?',[companyId,id]);
    if(kind==='overrun')return s?.status==='live';
    if(s?.status!=='pending_report')return false;
    const reports=await em.query('SELECT role,reporter_user_id,manual_actor_id FROM live_session_reports WHERE company_id=? AND session_id=?',[companyId,id]);
    const missing=[['anchor',s.anchor_user_id],['control',s.control_user_id]].filter(([role,uid])=>uid&&!reports.some((r:Record<string,unknown>)=>r.role===role&&(r.manual_actor_id||Number(r.reporter_user_id)===Number(uid))));
    if(parts[2]==='submit')return !missing.length;
    return parts[3]==='owner'?!!missing.length:missing.some(([,uid])=>Number(uid)===userId);
  }
  return true;
}
