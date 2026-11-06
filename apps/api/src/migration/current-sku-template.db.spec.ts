import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { FLOW_TEMPLATES, type StepDef } from '@kudesi/shared';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Department, FlowDefinition, FlowRun, Position, User, UserPermissionOverride, WorkItem } from '../entities';
import { buildServices } from '../test-support';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { importCurrentSkuTemplate } from './current-sku-template';
import { restoreWorkflowAccess } from './workflow-access';
import type { LegacyWorkflowSource } from './protocol';

const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('旧站当前SKU配置与退休在办快照分离（MySQL）',()=>{
  let ds:DataSource,svc:ReturnType<typeof buildServices>;
  beforeAll(async()=>{ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();svc=buildServices(ds);});
  afterAll(async()=>{await ds?.destroy();});
  async function fixture(){
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'当前SKU配置',status:'active'}));
    const dep=await ds.manager.save(Department,ds.manager.create(Department,{companyId:c.id,name:'仓库',status:'active',sortOrder:0}));
    const position=await ds.manager.save(Position,ds.manager.create(Position,{companyId:c.id,departmentId:dep.id,name:'财务',workspaceType:'finance',level:'staff',status:'active'}));
    const user=async(name:string,admin=false,warehouse=false,finance=false)=>ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:null,name,passwordHash:'!no-login',status:'active',mustChangePassword:false,isCompanyAdmin:admin,departmentId:warehouse?dep.id:null,positionId:finance?position.id:null,extraPositionIds:[]}));
    const actor=await user('执行人',true),wh1=await user('仓库甲',false,true),wh2=await user('仓库乙',false,true),fin=await user('财务',false,false,true);
    const ids=new Map<string,number>([['department:18',dep.id],['position:14',position.id],['user:20',wh1.id],['user:21',wh2.id],['user:30',fin.id]]);
    const oldSteps=FLOW_TEMPLATES.find(t=>t.key==='sku-batch-apply')!.steps.map(s=>({...s}));
    const old=await ds.manager.save(FlowDefinition,ds.manager.create(FlowDefinition,{companyId:c.id,templateKey:'sku-batch-apply',version:1,status:'retired',steps:oldSteps,escalateUserIds:[],createdBy:actor.id,publishedAt:null,publishedBy:null}));
    const nodes=[
      {id:70,node_key:'sales',node_name:'原运营提交',node_type:'submit',node_order:1,form_schema:{nodeTemplate:'bundle_sales',assignment:{mode:'single',sources:[]},timing:{enabled:false}},next_node_keys:['warehouse'],due_hours:1440},
      {id:71,node_key:'warehouse',node_name:'原仓库完善',node_type:'execute',node_order:2,handler_source_type:'department',handler_source_id:18,form_schema:{nodeTemplate:'bundle_fulfillment',assignment:{mode:'any',sources:[{type:'department',id:18}]},timing:{enabled:true,beforeMinutes:[20,10],overdueEveryMinutes:5}},next_node_keys:['finance'],reject_to_node_key:'sales',due_hours:60},
      {id:72,node_key:'finance',node_name:'原财务审核',node_type:'finance',node_order:3,handler_source_type:'position',handler_source_id:14,form_schema:{nodeTemplate:'bundle_review',assignment:{mode:'single',sources:[{type:'position',id:14}]},timing:{enabled:true,beforeMinutes:[20,10],overdueEveryMinutes:5}},next_node_keys:['end'],reject_to_node_key:'warehouse',due_hours:60},
      {id:73,node_key:'end',node_name:'原结束',node_type:'end',node_order:4,form_schema:{nodeTemplate:'end'},next_node_keys:[]},
    ].map(n=>({...n,template_id:9,action_config:{},is_optional:0}));
    // Quoted reference text is hashed as evidence only; it is never executed.
    const source:LegacyWorkflowSource={companyId:3,tables:{workflow_templates:[{id:9,company_id:3,related_object_type:'bundle_application',status:'active',flow_mode:'graph',form_schema:{batchProcessor:'bundle_application'},action_schema:{}}],workflow_template_nodes:nodes},currentSku:{templateId:'9',policyHash:'d1423fdd9fe64695155c6484845e478f52f7501dcdf2d10c6e61cb7f2f5d0a54',policyCode:readFileSync(join(__dirname,'fixtures/legacy-node-recipients.txt'),'utf8'),picks:[{nodeId:'71',employeeIds:['20','21'],mode:'any',departmentId:'18'},{nodeId:'72',employeeIds:['30'],mode:'single',departmentId:null}]},access:{policyHash:'a'.repeat(64),employees:[{employeeId:'20',canUseWorkflow:true,canViewCosts:false},{employeeId:'21',canUseWorkflow:true,canViewCosts:false},{employeeId:'30',canUseWorkflow:true,canViewCosts:true}]}};
    const run=()=>ds.transaction(async em=>{
      em.queryRunner!.data.legacyImport=true;
      const local=new Map(ids),lookup=(type:string,id:unknown)=>local.get(`${type}:${id}`);
      const access=await restoreWorkflowAccess(em,{companyId:c.id,sourceCompanyId:3,actorId:actor.id,source:source.access!,currentFinanceIds:[fin.id],lookup});
      const result=await importCurrentSkuTemplate({em,resources:svc.resources,crypto:svc.crypto,companyId:c.id,sourceCompanyId:3,actorId:actor.id,lookup,register:async(type,id,target)=>{local.set(`${type}:${id}`,target);}},source);
      return {result,access};
    });
    return {c,actor,wh1,wh2,fin,dep,position,old,oldSteps,source,run};
  }
  it('发布正常校验后的当前版本，原在办快照不变，仓库共享及60分钟提醒与原配置对应',async()=>{
    const f=await fixture();const {result,access}=await f.run();
    expect(result.created).toBe(true);expect(access.denied).toEqual([]);
    const active=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:f.c.id,templateKey:'sku-batch-apply',status:'active'});
    expect(active.version).toBe(2);
    expect((await ds.manager.findOneByOrFail(FlowDefinition,{id:f.old.id})).steps).toEqual(f.oldSteps);
    expect(active.steps[1]).toMatchObject({key:'warehouse',assignee:{source:'department',id:f.dep.id},dueMinutes:60,remind:{beforeMinutes:[20,10],overdueEveryMinutes:5}});
    expect(active.steps[2]).toMatchObject({key:'review',assignee:{source:'position',id:f.position.id},dueMinutes:60});
    expect(active.steps[2]).toHaveProperty('returnToKey','warehouse');
    const flow=new FlowService(ds,svc.resources,new FinanceDocumentsService(ds));
    expect((await flow.resolveRecipients(ds.manager,f.c.id,active.steps[1] as StepDef,f.actor.id)).sort()).toEqual([f.wh1.id,f.wh2.id].sort());
    expect(await flow.resolveRecipients(ds.manager,f.c.id,active.steps[2] as StepDef,f.actor.id)).toEqual([f.fin.id]);
    const templates=await flow.templates({id:f.wh1.id,companyId:f.c.id,name:f.wh1.name,permissions:{isCompanyAdmin:false,allow:['flow.apply.view'],deny:[]}});
    expect(templates.find(t=>t.key==='sku-batch-apply')).toMatchObject({active:true,startable:true});
    expect(await ds.manager.count(FlowRun,{where:{companyId:f.c.id}})).toBe(0);
    expect(await ds.manager.count(WorkItem,{where:{companyId:f.c.id}})).toBe(0);
    expect(Number((await ds.query('SELECT COUNT(*) n FROM outbox_jobs WHERE company_id=?',[f.c.id]))[0].n)).toBe(0);
  });
  it('人员结果不同、明确成本拒绝或策略指纹变化时整次配置回滚',async()=>{
    const f=await fixture();f.source.currentSku!.picks[0].employeeIds=['20'];
    await expect(f.run()).rejects.toThrow('新旧办理人不同');
    f.source.currentSku!.picks[0].employeeIds=['20','21'];
    await ds.manager.insert(UserPermissionOverride,{userId:f.fin.id,permission:'product.cost.view',effect:'deny'});
    await expect(f.run()).rejects.toThrow('最小权限');
    await ds.manager.delete(UserPermissionOverride,{userId:f.fin.id});
    f.source.currentSku!.policyCode+='\n';
    await expect(f.run()).rejects.toThrow('选人策略');
    expect(await ds.manager.count(FlowDefinition,{where:{companyId:f.c.id,status:'active'}})).toBe(0);
    expect(await ds.manager.count(UserPermissionOverride,{where:{userId:f.wh1.id}})).toBe(0);
  });
});
