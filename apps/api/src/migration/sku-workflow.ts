import { DataSource, In } from 'typeorm';
import { FLOW_TEMPLATES, createChecker, resolvePermissions } from '@kudesi/shared';
import { AuditLog, Company, FlowDefinition, Position, PositionPermission, User, UserPermissionOverride } from '../entities';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { ResourcesService } from '../resources/resources.service';
import { MigrationError } from './runner';
import { skuRepairHash } from './sku-repair';

export interface SkuWorkflowPlan { companyId:number;beforeHash:string;steps:unknown[];warehouseIds:number[];financeIds:number[];grants:string[] }
/** Use the standard designer and publish validation, in one rollback-capable transaction. */
export async function configureSkuWorkflow(ds:DataSource,resources:ResourcesService,opts:{companyId:number;actorId:number;expectedName:string;warehouseDepartmentId:number;financePositionId:number;grantRequiredFinancePermissions?:boolean;apply:boolean;expected?:SkuWorkflowPlan;prepare?:(plan:SkuWorkflowPlan)=>void}){
  const q=ds.createQueryRunner();await q.connect();await q.startTransaction();
  try{
    const company=await q.manager.findOneByOrFail(Company,{id:opts.companyId});if(company.name!==opts.expectedName)throw new MigrationError('流程目标公司名不一致');
    const actor=await q.manager.findOneByOrFail(User,{id:opts.actorId,companyId:company.id,status:'active',isCompanyAdmin:true}),user={id:actor.id,companyId:company.id,name:actor.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    const existing=await q.manager.find(FlowDefinition,{where:{companyId:company.id,templateKey:'sku-batch-apply'},order:{id:'ASC'},lock:{mode:'pessimistic_write'}});
    if(existing.length)throw new MigrationError('SKU流程已有人工配置，禁止直接覆盖，请在流程设计器核对');
    const steps=FLOW_TEMPLATES.find(t=>t.key==='sku-batch-apply')!.steps.map(s=>({...s,...(s.key==='warehouse'?{assignee:{source:'department' as const,id:opts.warehouseDepartmentId},mode:'any' as const}:s.key==='review'?{assignee:{source:'position' as const,id:opts.financePositionId}}:{})}));
    const bound=Object.create(ds) as DataSource;Object.defineProperty(bound,'manager',{value:q.manager});Object.defineProperty(bound,'transaction',{value:(fn:(em:typeof q.manager)=>Promise<unknown>)=>fn(q.manager)});
    const flow=new FlowService(bound,resources,new FinanceDocumentsService(bound));
    const warehouseIds=await flow.resolveRecipients(q.manager,company.id,steps.find(s=>s.key==='warehouse')!,actor.id),financeIds=await flow.resolveRecipients(q.manager,company.id,steps.find(s=>s.key==='review')!,actor.id);
    const permissionFacts=[],grants:string[]=[],required=['product.cost.view','resource.finance-bundles.create','resource.finance-bundles.edit'];
    if(opts.grantRequiredFinancePermissions){
      await q.manager.findOneByOrFail(Position,{id:opts.financePositionId,companyId:company.id,status:'active'});
      const current=await q.manager.find(PositionPermission,{where:{positionId:opts.financePositionId}});
      for(const permission of required)if(!current.some(r=>r.permission===permission)){await q.manager.save(PositionPermission,q.manager.create(PositionPermission,{positionId:opts.financePositionId,permission}));grants.push(permission);}
    }
    for(const id of financeIds){const finance=await q.manager.findOneByOrFail(User,{id,companyId:company.id}),positions=[finance.positionId,...(finance.extraPositionIds??[])].filter((x):x is number=>!!x),positionRows=positions.length?await q.manager.find(PositionPermission,{where:{positionId:In(positions)}}):[],overrides=await q.manager.find(UserPermissionOverride,{where:{userId:id}}),permissions=resolvePermissions({isCompanyAdmin:finance.isCompanyAdmin,positionPermissions:positionRows.map(r=>r.permission),overrides:overrides.map(r=>({permission:r.permission,effect:r.effect}))}),can=createChecker(permissions);
      if(!required.every(can))throw new MigrationError('配置的财务办理人缺少成本查看或组合维护权限，或存在明确禁止项，禁止发布');permissionFacts.push([id,permissions]);}
    const plan:SkuWorkflowPlan={companyId:company.id,beforeHash:skuRepairHash([existing,permissionFacts]),steps,warehouseIds,financeIds,grants};
    if(opts.apply&&(!opts.expected||skuRepairHash(plan)!==skuRepairHash(opts.expected)))throw new MigrationError('流程配置或办理人已变化，请重新空跑');
    await flow.saveDraft(user,'sku-batch-apply',steps,[]);await flow.publish(user,'sku-batch-apply');opts.prepare?.(plan);
    if(grants.length)await q.manager.insert(AuditLog,{companyId:company.id,actorId:actor.id,action:'flow.sku.required-permissions',resourceType:'position',resourceId:String(opts.financePositionId),detail:{grants,reason:'按已核对SKU财务办理岗位补齐成本查看及组合生成所需最小权限'}});
    if(opts.apply)await q.commitTransaction();else await q.rollbackTransaction();return plan;
  }catch(e){if(q.isTransactionActive)await q.rollbackTransaction();throw e;}finally{await q.release();}
}
