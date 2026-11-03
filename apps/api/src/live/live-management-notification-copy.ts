import { createHash } from 'crypto';
import { EntityManager } from 'typeorm';
import { Notification } from '../entities';
import type { FeishuNotice } from '../outbox/feishu-notice.service';
import { liveManagementRecipients } from './live-management-recipients';

type Input=Pick<Notification,'companyId'|'userId'|'kind'|'title'|'body'|'link'>;
type Delivery=Partial<Pick<FeishuNotice,'channel'|'resourceType'|'resourceId'|'kind'|'runId'|'liveEventKey'|'expiresAt'|'liveManagementCopySource'>>&{key?:string};
async function liveScope(em:EntityManager,companyId:number,meta:Delivery) {
  if(meta.resourceType==='live-notification'||meta.resourceType==='live-schedule')return true;
  if(meta.resourceType!=='flow-run'||!meta.runId)return false;
  const rows=await em.query("SELECT id FROM flow_runs WHERE company_id=? AND id=? AND template_key IN ('live-session-review','live-settlement')",[companyId,meta.runId]);
  return Array.isArray(rows)&&rows.length>0;
}
const eventKey=(meta:Delivery,sourceId?:number)=>meta.liveEventKey??`management-copy:${createHash('sha256').update(`${meta.resourceType}:${meta.key??sourceId}`).digest('hex')}`;
/** A direct HR recipient and its management copy share the same event reservation. */
export async function reserveDirectLiveHrNotice(em:EntityManager,input:Input,meta:Delivery) {
  if(meta.liveEventKey||meta.liveManagementCopySource!==undefined||!meta.key||!await liveScope(em,input.companyId,meta))return true;
  if(!(await liveManagementRecipients(em,input.companyId)).hr.includes(input.userId))return true;
  const result=await em.query('INSERT IGNORE INTO live_notification_events(company_id,event_key,user_id) VALUES(?,?,?)',[input.companyId,eventKey(meta),input.userId]);
  return !!result.affectedRows;
}
/** Copy information only: never add an approver, a work item, or page permissions. */
export async function copyLiveManagementNotice(em:EntityManager,input:Input,meta:Delivery,sourceId:number,write:(n:Input,d:Delivery)=>Promise<unknown>) {
  if(!Number.isSafeInteger(sourceId)||!await liveScope(em,input.companyId,meta))return;
  const audience=await liveManagementRecipients(em,input.companyId);
  if(!audience.management.includes(input.userId))return;
  const key=eventKey(meta,sourceId);
  for(const userId of audience.hr) {
    if(userId===input.userId)continue;
    const reserved=await em.query('INSERT IGNORE INTO live_notification_events(company_id,event_key,user_id) VALUES(?,?,?)',[input.companyId,key,userId]);
    if(!reserved.affectedRows)continue;
    await write({companyId:input.companyId,userId,kind:'live_management_copy',title:input.title,body:input.body,link:input.link},{...meta,key:meta.key??`management-copy:${sourceId}`,liveManagementCopySource:sourceId});
  }
}
/** Sending a queued copy requires both current HR membership and a current management source. */
export async function liveManagementCopySender(em:EntityManager,companyId:number,notice:FeishuNotice):Promise<number|null> {
  const id=notice.liveManagementCopySource;
  if(!Number.isSafeInteger(id)||!await liveScope(em,companyId,notice))return null;
  const audience=await liveManagementRecipients(em,companyId);
  if(!audience.hr.includes(notice.userId))return null;
  const source=await em.findOne(Notification,{where:{companyId,id}});
  return source&&audience.management.includes(source.userId)?source.userId:null;
}
