import { DataSource, In } from 'typeorm';
import { FLOW_TEMPLATES, createChecker, matchesPermission, resolvePermissions } from '@kudesi/shared';
import { AuditLog, Company, FlowDefinition, Position, PositionPermission, User, UserPermissionOverride } from '../entities';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { ResourcesService } from '../resources/resources.service';
import { MigrationError } from './runner';
import { skuRepairHash } from './sku-repair';

export interface SkuWorkflowPlan { companyId:number;beforeHash:string;steps:unknown[];warehouseIds:number[];financeIds:number[];grants:string[];accessGrants:Array<{userId:number;permission:string}>;accessDenied:Array<{userId:number;permission:string}> }
/** Use the standard designer and publish validation, in one rollback-capable transaction. */
export async function configureSkuWorkflow(ds:DataSource,resources:ResourcesService,opts:{companyId:number;actorId:number;expectedName:string;warehouseDepartmentId:number;financePositionId:number;grantRequiredFinancePermissions?:boolean;restoreLegacyWorkflowAccess?:boolean;sourceCompanyId?:number;apply:boolean;expected?:SkuWorkflowPlan;prepare?:(plan:SkuWorkflowPlan)=>void}){
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
    const accessGrants:Array<{userId:number;permission:string}>=[],accessDenied:Array<{userId:number;permission:string}>=[];
    // Legacy batch routes admitted every active company employee. Restore only migrated identities,
    // never new accounts or an explicit deny; this gives no cost, designer or external-write access.
    if(opts.restoreLegacyWorkflowAccess){
      if(!Number.isInteger(opts.sourceCompanyId)||!opts.sourceCompanyId||opts.sourceCompanyId<1)throw new MigrationError('恢复旧流程入口需要来源公司');
      const links:Array<{target_id:number}>=await q.manager.query("SELECT target_id FROM legacy_import_links WHERE source_system='legacy-oa' AND source_company_id=? AND company_id=? AND target_type='user' ORDER BY target_id",[opts.sourceCompanyId,company.id]);
      const ids=[...new Set(links.map(x=>Number(x.target_id)))];
      const users=ids.length?await q.manager.find(User,{where:{id:In(ids),companyId:company.id,status:'active'},order:{id:'ASC'}}):[];
      for(const member of users){
        const positions=[member.positionId,...(member.extraPositionIds??[])].filter((x):x is number=>!!x),rows=positions.length?await q.manager.find(PositionPermission,{where:{positionId:In(positions)}}):[],overrides=await q.manager.find(UserPermissionOverride,{where:{userId:member.id}}),permissions=resolvePermissions({isCompanyAdmin:member.isCompanyAdmin,positionPermissions:rows.map(r=>r.permission),overrides:overrides.map(r=>({permission:r.permission,effect:r.effect}))}),can=createChecker(permissions);
        permissionFacts.push([member.id,permissions]);
        for(const permission of ['flow.apply.view','workbench.todos.view','workbench.started.view']){
          if(can(permission))continue;
          if(overrides.some(r=>matchesPermission(r.permission,permission)&&r.effect==='deny')){accessDenied.push({userId:member.id,permission});continue;}
          await q.manager.save(UserPermissionOverride,q.manager.create(UserPermissionOverride,{userId:member.id,permission,effect:'allow'}));accessGrants.push({userId:member.id,permission});
        }
      }
      for(const id of [...warehouseIds,...financeIds])if(accessDenied.some(x=>x.userId===id&&['flow.apply.view','workbench.todos.view'].includes(x.permission)))throw new MigrationError('办理人明确禁止使用流程入口，禁止发布');
    }
    for(const id of financeIds){const finance=await q.manager.findOneByOrFail(User,{id,companyId:company.id}),positions=[finance.positionId,...(finance.extraPositionIds??[])].filter((x):x is number=>!!x),positionRows=positions.length?await q.manager.find(PositionPermission,{where:{positionId:In(positions)}}):[],overrides=await q.manager.find(UserPermissionOverride,{where:{userId:id}}),permissions=resolvePermissions({isCompanyAdmin:finance.isCompanyAdmin,positionPermissions:positionRows.map(r=>r.permission),overrides:overrides.map(r=>({permission:r.permission,effect:r.effect}))}),can=createChecker(permissions);
      if(!required.every(can))throw new MigrationError('配置的财务办理人缺少成本查看或组合维护权限，或存在明确禁止项，禁止发布');permissionFacts.push([id,permissions]);}
    const plan:SkuWorkflowPlan={companyId:company.id,beforeHash:skuRepairHash([existing,permissionFacts]),steps,warehouseIds,financeIds,grants,accessGrants,accessDenied};
    if(opts.apply&&(!opts.expected||skuRepairHash(plan)!==skuRepairHash(opts.expected)))throw new MigrationError('流程配置或办理人已变化，请重新空跑');
    await flow.saveDraft(user,'sku-batch-apply',steps,[]);await flow.publish(user,'sku-batch-apply');opts.prepare?.(plan);
    if(grants.length)await q.manager.insert(AuditLog,{companyId:company.id,actorId:actor.id,action:'flow.sku.required-permissions',resourceType:'position',resourceId:String(opts.financePositionId),detail:{grants,reason:'按已核对SKU财务办理岗位补齐成本查看及组合生成所需最小权限'}});
    if(accessGrants.length)await q.manager.insert(AuditLog,{companyId:company.id,actorId:actor.id,action:'flow.sku.legacy-access',resourceType:'company',resourceId:String(company.id),detail:{accessGrants,accessDenied,sourceCompanyId:opts.sourceCompanyId,reason:'恢复旧系统在职员工可使用的申请、待办及我发起的入口；保留明确禁止项'}});
    if(opts.apply)await q.commitTransaction();else await q.rollbackTransaction();return plan;
  }catch(e){if(q.isTransactionActive)await q.rollbackTransaction();throw e;}finally{await q.release();}
}
