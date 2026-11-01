import type { EntityManager } from 'typeorm';
import { FlowRun, FlowStep, User, WorkItem } from '../entities';
import { legacyWallTime as wall } from './legacy-time';

type Row=Record<string,any>;
interface Context {
  em:EntityManager;companyId:number;sourceCompanyId:number;
  lookup(type:string,id:unknown):number|undefined;
  register(type:string,id:string,target:number):Promise<void>;
}
/** Historical tasks are evidence, never newly issued work. Unknown feedback,
 * recurrence or review state blocks import rather than being silently dropped. */
export async function importClosedTask(ctx:Context,row:Row,sourceRun:Row,sourceNode:Row){
  const fail=()=>Error('旧历史任务存在未兼容字段、人员或流程关联');
  if(!ctx.em.queryRunner?.isTransactionActive||ctx.em.queryRunner.data.legacyImport!==true)throw fail();
  if(String(row.company_id)!==String(ctx.sourceCompanyId)||String(sourceRun.company_id)!==String(ctx.sourceCompanyId)||
    String(row.workflow_instance_id)!==String(sourceRun.id)||String(row.workflow_node_record_id)!==String(sourceNode.id)||String(sourceNode.workflow_instance_id)!==String(sourceRun.id)||
    !['completed','cancelled'].includes(row.status)||row.source_type!=='workflow'||!['workflow_batch','workflow_business'].includes(row.relation_type)||row.severity!=='normal'||
    row.template_id!=null||row.store_id!=null||row.submit_payload!=null||row.reviewed_at!=null||row.review_comment!=null||row.feedback_schema!=null||row.schedule_key!=null||
    (row.resolved_assignee_id!=null&&String(row.resolved_assignee_id)!==String(row.assignee_id))||String(row.feedback_to_id)!==String(sourceRun.requester_id))throw fail();
  const text=(v:unknown,max:number,required=false):string|null=>{if(v==null&&!required)return null;if(typeof v!=='string'||v.length>max||(required&&!v.trim()))throw fail();return v;};
  const person=async(old:unknown,optional=false)=>{
    if(old==null&&optional)return null;
    const id=ctx.lookup('user',old);
    if(!id||!await ctx.em.findOneBy(User,{id,companyId:ctx.companyId}))throw fail();
    return id;
  };
  const runId=ctx.lookup('flow_run',sourceRun.id),stepId=ctx.lookup('flow_step',sourceNode.id);
  const run=runId&&await ctx.em.findOneBy(FlowRun,{id:runId,companyId:ctx.companyId});
  if(!run||!stepId||!await ctx.em.findOneBy(FlowStep,{id:stepId,runId:run.id,companyId:ctx.companyId})||await person(row.feedback_to_id)!==run.requesterId)throw fail();
  const data={companyId:ctx.companyId,kind:'flow',runId:run.id,stepId,assigneeId:(await person(row.assignee_id))!,supervisorId:await person(row.supervisor_id,true),
    title:text(row.title,200,true)!,description:null,status:row.status==='completed'?'done' as const:'cancelled' as const,createdBy:null,routineId:null,scheduleKey:null,storeId:null,
    requiresReview:false,feedbackPreset:null,completionStandard:text(row.completion_standard,500),submitPayload:null,isAbnormal:false,
    dueAt:wall(row.due_at),createdAt:wall(row.created_at,true)!,finishedAt:wall(row.completed_at,true)!,doneNote:text(row.result_note,500),startedAt:null,submittedAt:wall(row.submitted_at),reviewNote:null,overdueNotifiedAt:null};
  const exists=ctx.lookup('work_item',row.id);
  if(exists){
    const actual=await ctx.em.findOneByOrFail(WorkItem,{id:exists,companyId:ctx.companyId});
    for(const [key,v] of Object.entries(data)){
      const a=actual[key as keyof WorkItem];
      if(v instanceof Date?a instanceof Date&&a.getTime()===v.getTime():a===v)continue;
      throw Error('旧历史任务与已迁记录不一致，未覆盖现有数据');
    }
    return {id:exists,reused:true};
  }
  const work=await ctx.em.save(WorkItem,ctx.em.create(WorkItem,data));
  await ctx.register('work_item',String(row.id),work.id);
  return {id:work.id,reused:false};
}
