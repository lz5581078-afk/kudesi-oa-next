import type { EntityManager } from 'typeorm';
import { FlowEvent,FlowRun,FlowStep,User } from '../entities';
import { legacyWallTime as wall } from './legacy-time';

type Row=Record<string,any>;
interface Context {
  em:EntityManager;companyId:number;sourceCompanyId:number;
  lookup(type:string,id:unknown):number|undefined;
  register(type:string,id:string,target:number):Promise<void>;
}
const LABEL:Record<string,string>={batch_edit:'修改申请',batch_transition:'节点办理',batch_reassignment:'改派办理人'};
/** Original event metadata only. The full before/after payload remains in the
 * encrypted source archive until its field ACL is reviewed. No workflow action,
 * financial posting or notification is replayed, and owner is never an actor. */
export async function importBusinessEvent(ctx:Context,row:Row,sourceRun:Row,sourceNode?:Row){
  const fail=()=>Error('旧业务事件的状态、真实操作人、原时点或流程关联未兼容');
  if(!ctx.em.queryRunner?.isTransactionActive||ctx.em.queryRunner.data.legacyImport!==true||String(row.company_id)!==String(ctx.sourceCompanyId)||String(sourceRun.company_id)!==String(ctx.sourceCompanyId)||
    String(row.workflow_instance_id)!==String(sourceRun.id)||sourceRun.graph_status!=='batch'||!Object.prototype.hasOwnProperty.call(LABEL,row.event_type)||row.amount!=null||typeof row.title!=='string'||!row.title.trim()||row.title.length>180)throw fail();
  const runId=ctx.lookup('flow_run',row.workflow_instance_id),actorId=ctx.lookup('user',row.actor_id);
  if(!runId||!actorId||!await ctx.em.findOneBy(FlowRun,{id:runId,companyId:ctx.companyId})||!await ctx.em.findOneBy(User,{id:actorId,companyId:ctx.companyId}))throw fail();
  let stepId:number|null=null;
  if(row.workflow_node_record_id!=null){
    stepId=ctx.lookup('flow_step',row.workflow_node_record_id)??null;
    if(!sourceNode||String(sourceNode.id)!==String(row.workflow_node_record_id)||String(sourceNode.workflow_instance_id)!==String(sourceRun.id)||!stepId||!await ctx.em.findOneBy(FlowStep,{id:stepId,runId,companyId:ctx.companyId}))throw fail();
  }else if(row.event_type!=='batch_edit')throw fail();
  const data={companyId:ctx.companyId,runId,stepId,actorId,action:'legacy',note:`${LABEL[row.event_type]}：${row.title}`,createdAt:wall(row.created_at,true)!};
  const existing=ctx.lookup('flow_event',row.id);
  if(existing){
    const e=await ctx.em.findOneByOrFail(FlowEvent,{id:existing,companyId:ctx.companyId});
    if(Object.entries(data).some(([k,v])=>v instanceof Date?(e[k as keyof FlowEvent] as Date).getTime()!==v.getTime():e[k as keyof FlowEvent]!==v))throw fail();
    return {id:existing,reused:true};
  }
  const event=await ctx.em.save(FlowEvent,ctx.em.create(FlowEvent,data));
  await ctx.register('flow_event',String(row.id),event.id);
  return {id:event.id,reused:false};
}
