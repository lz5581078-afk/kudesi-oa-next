import { createHash } from 'node:crypto';
import { DataSource, In, type EntityManager } from 'typeorm';
import { createChecker, resolvePermissions, type StepDef } from '@kudesi/shared';
import { FlowDefinition, PositionPermission, User, UserPermissionOverride } from '../entities';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import type { ResourcesService } from '../resources/resources.service';
import type { CryptoService } from '../common/crypto.service';
import type { LegacyWorkflowSource } from './protocol';
import { mapLegacySkuSteps } from './sku-continuation';
import { preserveSourceRow } from './source-rows';

const json=(v:any)=>typeof v==='string'?JSON.parse(v):v??{};
interface Context {em:EntityManager;resources:ResourcesService;crypto:CryptoService;companyId:number;sourceCompanyId:number;actorId:number;lookup(type:string,id:unknown):number|undefined;register(type:string,id:string,target:number):Promise<void>}
/** Publish only the source's current SKU configuration, through the regular
 * designer validation, inside the caller's migration transaction. No run starts. */
export async function importCurrentSkuTemplate(ctx:Context,source:LegacyWorkflowSource):Promise<{created:boolean;reused:boolean;sourceRowReused?:boolean;steps?:StepDef[]}>{
  if(!ctx.em.queryRunner?.isTransactionActive||ctx.em.queryRunner.data.legacyImport!==true||source.companyId!==ctx.sourceCompanyId)throw Error('旧SKU当前配置缺少迁移事务或公司范围');
  const templates=(source.tables.workflow_templates??[]).filter(t=>t.related_object_type==='bundle_application'&&t.status==='active');
  if(!templates.length)return {created:false,reused:false};
  if(templates.length!==1)throw Error('旧SKU存在多个启用模板，不能合并');
  const template=templates[0],policy=source.currentSku;
  if(!policy||policy.templateId!==String(template.id)||policy.policyHash!=='d1423fdd9fe64695155c6484845e478f52f7501dcdf2d10c6e61cb7f2f5d0a54'||createHash('sha256').update(policy.policyCode).digest('hex')!==policy.policyHash)throw Error('旧SKU当前配置缺少已核对的选人策略');
  if(template.flow_mode!=='graph'||json(template.form_schema).batchProcessor!=='bundle_application'||Object.keys(json(template.action_schema)).length)throw Error('旧SKU当前配置业务处理器或自动动作尚未兼容');
  const sourceRow=await preserveSourceRow(ctx.em,ctx.crypto,{companyId:ctx.companyId,sourceCompanyId:ctx.sourceCompanyId,table:'legacy_sku_assignment_policy',key:'current'},policy as unknown as Record<string,unknown>);
  const exists=ctx.lookup('current_sku_definition',template.id);
  if(exists){await ctx.em.findOneByOrFail(FlowDefinition,{id:exists,companyId:ctx.companyId,templateKey:'sku-batch-apply',status:'active'});return {created:false,reused:true,sourceRowReused:sourceRow.reused};}
  if(await ctx.em.findOneBy(FlowDefinition,{companyId:ctx.companyId,templateKey:'sku-batch-apply',status:'active'}))throw Error('旧SKU目标已有启用配置，禁止覆盖人工修改');
  const nodes=(source.tables.workflow_template_nodes??[]).filter(n=>String(n.template_id)===String(template.id)).sort((a,b)=>Number(a.node_order)-Number(b.node_order));
  const steps=mapLegacySkuSteps(nodes,ctx.lookup);
  for(const [i,node] of nodes.entries()){
    if(Object.keys(json(node.action_config)).length||Number(node.is_optional??0)!==0)throw Error('旧SKU当前配置含未核对的自动动作或可选节点');
    const schema=json(node.form_schema),assignment=schema.assignment??{};
    if(i>0&&i<nodes.length-1){
      const sources=assignment.sources?.length?assignment.sources:[{type:node.handler_source_type,id:node.handler_source_id}];
      if(sources.length!==1||sources[0].type!==node.handler_source_type||String(sources[0].id)!==String(node.handler_source_id))throw Error('旧SKU当前配置的主来源与选人表单不一致');
      const mode=assignment.mode??'single';
      if((node.handler_source_type==='department'&&mode!=='any')||(node.handler_source_type!=='department'&&mode!=='single'))throw Error('旧SKU当前配置多人规则尚未兼容');
    }
    const timing=schema.timing;
    if(timing?.enabled===true){
      if(!Array.isArray(timing.beforeMinutes)||timing.beforeMinutes.some((v:any)=>!Number.isSafeInteger(v)||v<1)||!Number.isSafeInteger(timing.overdueEveryMinutes)||timing.overdueEveryMinutes<1)throw Error('旧SKU当前配置提醒规则尚未兼容');
      steps[i].remind={beforeMinutes:[...timing.beforeMinutes],overdueEveryMinutes:timing.overdueEveryMinutes};
    }
  }
  const actor=await ctx.em.findOneByOrFail(User,{id:ctx.actorId,companyId:ctx.companyId,isCompanyAdmin:true,status:'active'});
  const bound=Object.create(ctx.em.connection) as DataSource;
  Object.defineProperty(bound,'manager',{value:ctx.em});Object.defineProperty(bound,'transaction',{value:(fn:(em:EntityManager)=>Promise<unknown>)=>fn(ctx.em)});
  const service=new FlowService(bound,ctx.resources,new FinanceDocumentsService(bound));
  for(const [i,node] of nodes.entries())if(i>0&&i<nodes.length-1){
    const pick=policy.picks.find(p=>p.nodeId===String(node.id));
    if(!pick||pick.mode!==(json(node.form_schema).assignment?.mode??'single'))throw Error('旧SKU当前节点缺少选人结果');
    const expected=pick.employeeIds.map(id=>ctx.lookup('user',id));
    if(expected.some(id=>!id)||new Set(expected).size!==expected.length)throw Error('旧SKU当前节点人员未完整迁入');
    const actual=await service.resolveRecipients(ctx.em,ctx.companyId,steps[i],actor.id);
    if(JSON.stringify([...actual].sort((a,b)=>a-b))!==JSON.stringify((expected as number[]).sort((a,b)=>a-b)))throw Error('旧SKU当前节点的新旧办理人不同');
    if(steps[i].type==='finance')for(const id of actual){
      const user=await ctx.em.findOneByOrFail(User,{id,companyId:ctx.companyId}),ids=[user.positionId,...(user.extraPositionIds??[])].filter((id):id is number=>id!=null);
      const permissions=ids.length?await ctx.em.find(PositionPermission,{where:{positionId:In(ids)}}):[],overrides=await ctx.em.find(UserPermissionOverride,{where:{userId:id}});
      const can=createChecker(resolvePermissions({isCompanyAdmin:user.isCompanyAdmin,positionPermissions:permissions.map(p=>p.permission),overrides:overrides.map(o=>({permission:o.permission,effect:o.effect}))}));
      const required = i===nodes.length-2
        ? ['product.cost.view','resource.finance-bundles.create','resource.finance-bundles.edit']
        : ['product.cost.view'];
      if(!required.every(can))throw Error('旧SKU当前财务缺少原生办理所需最小权限，禁止发布');
    }
  }
  const user={id:actor.id,companyId:ctx.companyId,name:actor.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
  await service.saveDraft(user,'sku-batch-apply',steps,[]);await service.publish(user,'sku-batch-apply');
  const definition=await ctx.em.findOneByOrFail(FlowDefinition,{companyId:ctx.companyId,templateKey:'sku-batch-apply',status:'active'});
  await ctx.register('current_sku_definition',String(template.id),definition.id);
  return {created:true,reused:false,sourceRowReused:sourceRow.reused,steps};
}
