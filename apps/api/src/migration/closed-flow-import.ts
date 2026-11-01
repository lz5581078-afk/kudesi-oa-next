import type { EntityManager } from 'typeorm';
import type { FieldDef, StepDef } from '@kudesi/shared';
import { FlowDefinition, FlowRun, FlowStep, FlowTemplateRow, User } from '../entities';
import type { LegacyWorkflowSource } from './protocol';
import { legacyWallTime as wall } from './legacy-time';
import { CLOSED_SKU_FIELDS, CLOSED_SKU_STEP_FIELDS, closedSkuForm, closedSkuPayload } from './closed-sku-forms';

type Row=Record<string,any>;
interface Context {
  em:EntityManager;companyId:number;sourceCompanyId:number;actorId:number;
  lookup(type:string,id:unknown):number|undefined;
  register(type:string,id:string,target:number):Promise<void>;
}
const key='legacy-history';
const fields:FieldDef[]=[
  {key:'legacyStatus',label:'原流程状态',type:'text',group:'原流程',readonly:true},
  {key:'legacySourceId',label:'原流程编号',type:'text',group:'原流程',readonly:true},
  {key:'legacyTemplate',label:'原流程类型',type:'text',group:'原流程',readonly:true},
];
const stepFields:FieldDef[]=[
  {key:'legacyStatus',label:'原节点状态',type:'text',group:'原节点',readonly:true},
  {key:'legacyAction',label:'原办理动作',type:'text',group:'原节点',readonly:true},
];
const parsed=(v:any)=>v==null?{}:typeof v==='string'?JSON.parse(v):v;
/** A closed source run is a read-only timeline. Never call start/pass/finish,
 * generate work items, replay notifications, or infer an approver from owner. */
export async function importClosedFlow(ctx:Context,source:LegacyWorkflowSource,row:Row){
  if(!ctx.em.queryRunner?.isTransactionActive||ctx.em.queryRunner.data.legacyImport!==true||String(row.company_id)!==String(ctx.sourceCompanyId))throw Error('旧历史流程缺少迁移事务或公司范围');
  if(!['completed','cancelled','rejected','skipped'].includes(row.status)||typeof row.title!=='string'||!row.title.trim()||row.title.length>200)throw Error('旧历史流程状态或标题无法对应');
  const createdAt=wall(row.created_at,true)!,finishedAt=wall(row.completed_at,true)!,dueAt=wall(row.due_at);
  const existing=ctx.lookup('flow_run',row.id);
  if(existing){await ctx.em.findOneByOrFail(FlowRun,{id:existing,companyId:ctx.companyId,templateKey:key});return {runId:existing,reused:true};}
  const person=async(old:unknown)=>{
    if(old==null)return null;
    const id=ctx.lookup('user',old);
    if(!id||!await ctx.em.findOneBy(User,{id,companyId:ctx.companyId}))throw Error('旧历史流程人员未迁入本公司');
    return id;
  };
  const requesterId=await person(row.requester_id);
  if(!requesterId)throw Error('旧历史流程缺少原申请人');
  const sku=row.graph_status==='batch';
  const items=(source.tables.workflow_batch_items??[]).filter(i=>String(i.workflow_instance_id)===String(row.id));
  if(sku&&items.length!==1)throw Error('旧历史流程缺少唯一原SKU申请资料');
  const originalPayload=sku?closedSkuPayload(items[0].payload_json):{};
  const records=(source.tables.workflow_node_records??[]).filter(r=>String(r.workflow_instance_id)===String(row.id)).sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||Number(a.id)-Number(b.id));
  const steps:StepDef[]=[];
  const projections=[];
  const schemas:Record<string,FieldDef[]>={};
  for(const r of records){
    if(Number(r.is_active)!==0||!['completed','returned','rejected','cancelled','skipped'].includes(r.status)||typeof r.node_name!=='string'||!r.node_name||r.node_name.length>40||!['submit','approval','execute','finance','archive'].includes(r.node_type))throw Error('旧历史流程仍有活节点或未知节点，不能按结束流程归档');
    if(r.comment!=null&&(typeof r.comment!=='string'||r.comment.length>500))throw Error('旧历史流程意见超出原生字段范围');
    const stepKey=`record_${r.id}`;
    if(stepKey.length>32)throw Error('旧历史流程节点编号过长');
    const type=r.node_type==='archive'?'execute':r.node_type;
    steps.push({key:stepKey,name:r.node_name,type});schemas[stepKey]=sku?[...stepFields,...CLOSED_SKU_STEP_FIELDS]:stepFields;
    const recipients=(source.tables.workflow_node_recipients??[]).filter(x=>String(x.node_record_id)===String(r.id)).map(x=>x.employee_id);
    if(!recipients.length&&r.owner_id!=null)recipients.push(r.owner_id);
    const timing=parsed(r.timing_json);
    const status:FlowStep['status']=r.status==='returned'||r.action==='return'?'returned':r.status==='completed'?'done':r.status;
    projections.push({r,stepKey,type,status,form:sku?closedSkuForm(r.form_payload):{},recipients:[...new Set(await Promise.all(recipients.map(person)))].filter((id):id is number=>id!=null),handledBy:timing.handledBy==null?null:await person(timing.handledBy)});
  }
  if(!ctx.lookup('legacy_flow_template','history')){
    const template=await ctx.em.save(FlowTemplateRow,ctx.em.create(FlowTemplateRow,{companyId:ctx.companyId,templateKey:key,name:'旧流程历史',description:'只读保留原流程进度、状态和时间',sourceKey:'legacy-oa-history',departmentId:null,createdBy:ctx.actorId}));
    await ctx.register('legacy_flow_template','history',template.id);
  }
  const [last]=await ctx.em.query('SELECT COALESCE(MAX(version),0) version FROM flow_definitions WHERE company_id=? AND template_key=?',[ctx.companyId,key]);
  const def=await ctx.em.save(FlowDefinition,ctx.em.create(FlowDefinition,{companyId:ctx.companyId,templateKey:key,version:Number(last.version)+1,status:'retired',steps,schemaJson:{fields:sku?[...fields,...CLOSED_SKU_FIELDS]:fields,stepFields:schemas,posting:null},escalateUserIds:[],starterScope:null,createdBy:ctx.actorId,publishedAt:null,publishedBy:null}));
  await ctx.register('legacy_flow_definition',`history:${row.id}`,def.id);
  const template=(source.tables.workflow_templates??[]).find(t=>String(t.id)===String(row.template_id));
  const run=await ctx.em.save(FlowRun,ctx.em.create(FlowRun,{companyId:ctx.companyId,definitionId:def.id,templateKey:key,title:row.title,status:row.status==='skipped'?'cancelled':row.status,requesterId,currentStepKey:null,payload:{legacyStatus:row.status,legacySourceId:String(row.id),legacyTemplate:String(template?.name??template?.title??row.template_id),...originalPayload},stepsSnapshot:steps,escalateUserIds:[],revision:1,dueAt,requestKey:`legacy-oa:history:${ctx.sourceCompanyId}:${row.id}`,createdAt,finishedAt}));
  await ctx.register('flow_run',String(row.id),run.id);
  for(const [i,p] of projections.entries()){
    const step=await ctx.em.save(FlowStep,ctx.em.create(FlowStep,{companyId:ctx.companyId,runId:run.id,seq:i+1,stepKey:p.stepKey,stepName:p.r.node_name,stepType:p.type,status:p.status,enteredVia:'normal',recipients:p.recipients,handledBy:p.handledBy,action:null,comment:p.r.comment??null,form:{legacyStatus:p.r.status,legacyAction:p.r.action??'',...p.form},enteredAt:wall(p.r.created_at,true)!,finishedAt:wall(p.r.completed_at),dueAt:null}));
    await ctx.register('flow_step',String(p.r.id),step.id);
  }
  return {runId:run.id,reused:false};
}
