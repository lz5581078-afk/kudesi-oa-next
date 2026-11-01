import { DataSource, In, type EntityManager } from 'typeorm';
import { createChecker, resolvePermissions } from '@kudesi/shared';
import { FlowRun, Position, PositionPermission, User, UserPermissionOverride } from '../entities';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import type { ResourcesService } from '../resources/resources.service';
import type { AuthUser } from '../common/auth.decorators';

/** Read every imported workflow through the actual detail service before the
 * migration can commit. The bound manager sees this transaction's pending rows;
 * no HTTP server, scheduler, business action or message worker is involved. */
export async function verifyWorkflowView(em:EntityManager,resources:ResourcesService,companyId:number,runId:number){
  if(!em.queryRunner?.isTransactionActive||em.queryRunner.data.legacyImport!==true)throw Error('旧流程读取验收必须位于迁移事务');
  const run=await em.findOneByOrFail(FlowRun,{id:runId,companyId});
  const member=await em.findOneByOrFail(User,{id:run.requesterId,companyId});
  const positionIds=[...new Set([member.positionId,...(member.extraPositionIds??[])].filter((id):id is number=>id!=null))];
  const positions=positionIds.length?await em.find(Position,{where:{companyId,id:In(positionIds)}}):[];
  if(positions.length!==positionIds.length)throw Error('旧流程读取验收发现跨公司或失效岗位引用');
  const permissions=positionIds.length?await em.find(PositionPermission,{where:{positionId:In(positionIds)}}):[],overrides=await em.find(UserPermissionOverride,{where:{userId:member.id}});
  const user:AuthUser={id:member.id,companyId,name:member.name,permissions:resolvePermissions({isCompanyAdmin:member.isCompanyAdmin,positionPermissions:permissions.map(p=>p.permission),overrides:overrides.map(o=>({permission:o.permission,effect:o.effect}))})};
  const bound=Object.create(em.connection) as DataSource;Object.defineProperty(bound,'manager',{value:em});
  const service=new FlowService(bound,resources,new FinanceDocumentsService(bound));
  const detail=await service.detail(user,runId),can=createChecker(user.permissions);
  if(Object.keys(detail.payload).some(k=>k.startsWith('_')))throw Error('旧流程读取验收发现内部字段泄露');
  const oldForms=[...detail.steps.map(s=>s.form).filter((v):v is Record<string,unknown>=>v!=null),...(detail.legacyHistory?.steps.map(s=>s.values)??[])];
  for(const form of oldForms){
    if(!can('product.cost.view')&&Object.prototype.hasOwnProperty.call(form,'legacySkuInspection'))throw Error('旧流程读取验收发现成本越权');
    if(!can('finance.bundle-sync.manage')&&Object.prototype.hasOwnProperty.call(form,'legacySkuSync'))throw Error('旧流程读取验收发现同步明细越权');
    if(form.legacyDuplicateConfirmation&&Object.prototype.hasOwnProperty.call(JSON.parse(String(form.legacyDuplicateConfirmation)),'token'))throw Error('旧流程读取验收发现原确认令牌泄露');
  }
  if(run.templateKey==='sku-batch-apply'&&typeof run.payload._legacySkuItemId==='string'&&!detail.legacyHistory?.request)throw Error('旧流程读取验收缺少迁入前申请资料');
  const [closedTasks]=await em.query("SELECT COUNT(*) n FROM work_items w JOIN legacy_import_links l ON l.company_id=w.company_id AND l.target_id=w.id AND l.target_type='work_item' AND l.source_system='legacy-oa' AND LEFT(l.source_key,10)='work_item:' WHERE w.company_id=? AND w.run_id=? AND w.kind='flow' AND w.status IN ('done','cancelled')",[companyId,runId]);
  const historicalTasks=detail.historicalTasks?.length??0;
  if(historicalTasks!==Number(closedTasks.n))throw Error('旧流程读取验收发现原发起人缺少历史任务反馈');
  return {legacySkuHistory:Boolean(detail.legacyHistory),costRestricted:!can('product.cost.view'),syncRestricted:!can('finance.bundle-sync.manage'),historicalTasks};
}
