import {DataSource} from 'typeorm';
import type {AuthUser} from '../common/auth.decorators';
import {SKU_GROUP_PATTERN} from './sku-batch-reference';
const TEMPLATE='sku-batch-apply';
const KEY=`CASE WHEN REGEXP_LIKE(JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$._batchKey')), '^(${SKU_GROUP_PATTERN})$', 'c') THEN JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$._batchKey')) ELSE CONCAT('run-',r.id) END`;
interface Header {id:number;batchRef:string;title:string;userId:number;createdAt:Date|string}
interface Member {id:number;batchRef:string;title:string;batchName:string|null;status:string;requesterName:string;specCount:number;createdAt:Date|string;stepName:string|null;recipients:number[]|string|null;enteredVia:string|null}
const recipients=(value:Member['recipients']):number[]=>{try{const rows=typeof value==='string'?JSON.parse(value):value;return Array.isArray(rows)?rows.filter(id=>Number.isSafeInteger(id)&&id>0):[];}catch{return [];}};
/** 只读现有统一流程：按真实申请标记分页，完整汇总同一申请的各规格。 */
export async function listSkuApplications(ds:DataSource,user:AuthUser,q:{page:number;pageSize:number;keyword?:string},namesFor:(ids:number[])=>Promise<Map<number,string>>,label:string){
 const where='r.company_id = ? AND r.requester_id = ? AND r.template_key = ?';
 const args:unknown[]=[user.companyId,user.id,TEMPLATE];
 const filter=q.keyword?.trim()?`${where} AND r.title LIKE ?`:where;
 if(q.keyword?.trim())args.push(`%${q.keyword.trim()}%`);
 const {total,refs,rows,headers}=await ds.transaction(async em=>{
  const headerWhere='h.company_id=? AND h.user_id=? AND h.module_key=?',headerArgs:unknown[]=[user.companyId,user.id,`flow-application:${TEMPLATE}`];
  const headerFilter=q.keyword?.trim()?`${headerWhere} AND h.title LIKE ?`:headerWhere;if(q.keyword?.trim())headerArgs.push(`%${q.keyword.trim()}%`);
  const union=`SELECT ${KEY} AS batchRef,r.id AS runId,NULL AS headerId,r.created_at AS createdAt FROM flow_runs r WHERE ${filter} UNION ALL SELECT h.source_record_id AS batchRef,NULL AS runId,h.id AS headerId,h.created_at AS createdAt FROM form_drafts h WHERE ${headerFilter}`;
  const [{n}]=await em.query(`SELECT COUNT(DISTINCT batchRef) AS n FROM (${union}) groups_by_application`,[...args,...headerArgs]);
  const refs:Array<{batchRef:string;id:number}>=await em.query(`SELECT batchRef,COALESCE(MAX(headerId),MIN(runId)) AS id,MIN(createdAt) AS firstCreatedAt FROM (${union}) groups_by_application GROUP BY batchRef ORDER BY firstCreatedAt DESC,id DESC LIMIT ? OFFSET ?`,[...args,...headerArgs,q.pageSize,(q.page-1)*q.pageSize]);
  if(!refs.length)return {total:Number(n),refs,rows:[] as Member[],headers:[] as Header[]};
  const selected=refs.map(row=>row.batchRef),marks=selected.map(()=>'?').join(',');
  const headers:Header[]=await em.query(`SELECT h.id,h.source_record_id AS batchRef,h.title,h.user_id AS userId,h.created_at AS createdAt FROM form_drafts h WHERE ${headerWhere} AND h.source_record_id IN (${marks})`,[user.companyId,user.id,`flow-application:${TEMPLATE}`,...selected]);
  const rows:Member[]=await em.query(`SELECT r.id,${KEY} AS batchRef,r.title,r.status,JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.batchName')) AS batchName,COALESCE(JSON_LENGTH(JSON_EXTRACT(r.payload,'$.specs')),0) AS specCount,r.created_at AS createdAt,u.name AS requesterName,
   (SELECT s.step_name FROM flow_steps s WHERE s.run_id=r.id AND s.company_id=r.company_id AND s.status='active' ORDER BY s.seq DESC LIMIT 1) AS stepName,
   (SELECT s.recipients FROM flow_steps s WHERE s.run_id=r.id AND s.company_id=r.company_id AND s.status='active' ORDER BY s.seq DESC LIMIT 1) AS recipients,
   (SELECT s.entered_via FROM flow_steps s WHERE s.run_id=r.id AND s.company_id=r.company_id AND s.status='active' ORDER BY s.seq DESC LIMIT 1) AS enteredVia
   FROM flow_runs r JOIN users u ON u.id=r.requester_id AND u.company_id=r.company_id WHERE ${where} AND (${KEY}) IN (${marks}) ORDER BY r.id`,[user.companyId,user.id,TEMPLATE,...selected]);
  return {total:Number(n),refs,rows,headers};
 });
 const names=await namesFor([...new Set([...rows.flatMap(row=>recipients(row.recipients)),...headers.map(header=>Number(header.userId))])]);
 return {total,page:q.page,pageSize:q.pageSize,rows:refs.flatMap(ref=>{
  const members=rows.filter(row=>row.batchRef===ref.batchRef),first=members[0],header=headers.find(row=>row.batchRef===ref.batchRef);if(!first&&!header)return [];
  const progress=new Map<string,{name:string;handlers:string[];count:number;returned:boolean}>();
  for(const row of members.filter(row=>row.status==='running'||row.status==='draft')){const handlers=recipients(row.recipients).map(id=>names.get(id)??'').filter(Boolean),returned=row.enteredVia==='return',name=row.stepName||'节点待确认',key=JSON.stringify([name,handlers,returned]);const current=progress.get(key)??{name,handlers,count:0,returned};current.count+=Number(row.specCount);progress.set(key,current);}
  const states=[...new Set(members.map(row=>row.status))],status=!states.length?'draft':states.includes('running')?'running':states.every(state=>state==='cancelled')?'cancelled':states.every(state=>state==='completed'||state==='cancelled')?'completed':states.length===1?states[0]:'mixed';
  return [{id:Number(ref.id),batchRef:ref.batchRef,templateKey:TEMPLATE,templateLabel:label,title:header?.title || (first?.batchName&&first.batchName!=='null'?first.batchName:first?.title) || '',status,requesterName:header?names.get(Number(header.userId)) ?? '':first.requesterName,createdAt:header?.createdAt ?? first.createdAt,finishedAt:null,dueAt:null,stepName:null,handlers:[],overdue:false,specCount:members.reduce((sum,row)=>sum+Number(row.specCount),0),completedSpecs:members.filter(row=>row.status==='completed').reduce((sum,row)=>sum+Number(row.specCount),0),progress:[...progress.values()]}];
 })};
}
