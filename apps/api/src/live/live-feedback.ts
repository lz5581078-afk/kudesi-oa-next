import { EntityManager } from 'typeorm';
import { ResourceFile } from '../entities';
import { Row, liveFail, wallNow, liveClock } from './live-core';
export const LIVE_EVIDENCE_TYPE='live-checkout';
export interface LiveRatingInput { userId:number;score:number }
export interface LiveFeedbackInput { evidenceFileIds?:number[];ratings?:LiveRatingInput[] }
export async function feedbackTargets(em:EntityManager,companyId:number,s:Row,reporterId:number) {
  const rows:Row[]=await em.query(`SELECT DISTINCT c.user_id userId,u.name,c.role FROM live_session_checkins c
    JOIN users u ON u.company_id=c.company_id AND u.id=c.user_id
    WHERE c.company_id=? AND c.session_id=? AND c.user_id<>? AND
    ((c.role='anchor' AND c.user_id=?) OR (c.role='control' AND c.user_id=?) OR (c.role='operator' AND c.user_id=?)) ORDER BY c.role,c.user_id`,[companyId,s.id,reporterId,s.anchor_user_id,s.control_user_id,s.operator_user_id]);
  return rows.map(r=>({userId:Number(r.userId),name:String(r.name),role:String(r.role)}));
}
export async function saveCheckoutFeedback(em:EntityManager,companyId:number,s:Row,reporterId:number,role:string,input:LiveFeedbackInput) {
  const targets=await feedbackTargets(em,companyId,s,reporterId);
  const ratings=input.ratings??[],ids=input.evidenceFileIds??[];
  if(!Array.isArray(ratings)||ratings.some(r=>!r||typeof r!=='object')||ratings.length!==targets.length||new Set(ratings.map(r=>r.userId)).size!==ratings.length||ratings.some(r=>!Number.isInteger(r.score)||r.score<0||r.score>10||!targets.some(t=>t.userId===r.userId)))liveFail('请为本场实际参与的其他人员逐一评分（0～10分），人员变化时请刷新核对',400);
  if(!Array.isArray(ids)||ids.length>10||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<=0))liveFail('直播数据图片无效，最多10张',400);
  if(role==='control'&&!ids.length)liveFail('中控下播须上传本场直播数据图片',400);
  if(role!=='control'&&ids.length)liveFail('仅本场中控可提交直播数据图片',400);
  for(const id of ids){
    const file=await em.findOneBy(ResourceFile,{id,companyId,resourceType:LIVE_EVIDENCE_TYPE,resourceId:Number(s.id),fieldKey:'evidence',uploadedBy:reporterId});
    if(!file||!file.mime.startsWith('image/'))liveFail('请选择本人上传的本场直播数据图片',400);
  }
  const snapshot={reporterId,role,submittedAt:wallNow(liveClock.now()),evidenceFileIds:ids,ratings:targets.map(t=>({...t,score:ratings.find(r=>r.userId===t.userId)!.score}))};
  const [previous]:Row[]=await em.query('SELECT confirmation_json FROM live_session_checkins WHERE company_id=? AND session_id=? AND user_id=? AND role=?',[companyId,s.id,reporterId,role]);
  if(!previous)liveFail('请先确认本人上播',400);
  await em.query("UPDATE live_session_checkins SET confirmation_json=JSON_SET(confirmation_json,'$.checkoutFeedback',CAST(? AS JSON)) WHERE company_id=? AND session_id=? AND user_id=? AND role=?",[JSON.stringify(snapshot),companyId,s.id,reporterId,role]);
  const before=typeof previous.confirmation_json==='string'?JSON.parse(previous.confirmation_json):previous.confirmation_json;
  await em.query("INSERT INTO audit_logs(company_id,actor_id,action,resource_type,resource_id,detail) VALUES(?,?,'live.checkout.feedback','live-session',?,?)",[companyId,reporterId,String(s.id),JSON.stringify({before:before.checkoutFeedback??null,after:snapshot})]);
}
export async function checkoutFeedbackRecords(em:EntityManager,companyId:number,sessionId:number) {
  const rows:Row[]=await em.query(`SELECT c.user_id,c.role,c.confirmation_json,u.name FROM live_session_checkins c JOIN users u ON u.company_id=c.company_id AND u.id=c.user_id WHERE c.company_id=? AND c.session_id=? ORDER BY c.role`,[companyId,sessionId]);
  const out=[];
  for(const row of rows){
    const confirmation=typeof row.confirmation_json==='string'?JSON.parse(row.confirmation_json):row.confirmation_json;
    const feedback=confirmation?.checkoutFeedback;if(!feedback)continue;
    const images=[];
    for(const id of feedback.evidenceFileIds??[]){const f=await em.findOneBy(ResourceFile,{id:Number(id),companyId,resourceType:LIVE_EVIDENCE_TYPE,resourceId:sessionId});if(f)images.push({id:f.id,name:f.name,mime:f.mime,size:f.size});}
    out.push({...feedback,reporterName:row.name,images});
  }
  return out;
}
export async function checkoutAttendance(em:EntityManager,companyId:number,sessionId:number){
 const rows:Row[]=await em.query("SELECT c.user_id userId,c.role,u.name,DATE_FORMAT(c.start_at,'%Y-%m-%d %H:%i:%s') startAt,DATE_FORMAT(c.end_at,'%Y-%m-%d %H:%i:%s') endAt FROM live_session_checkins c JOIN users u ON u.company_id=c.company_id AND u.id=c.user_id WHERE c.company_id=? AND c.session_id=? ORDER BY c.role",[companyId,sessionId]);
 return rows.map(r=>({userId:Number(r.userId),name:String(r.name),role:String(r.role),startAt:String(r.startAt),endAt:r.endAt==null?null:String(r.endAt)}));
}
