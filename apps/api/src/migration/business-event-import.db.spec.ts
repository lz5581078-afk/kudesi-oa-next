import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { FLOW_TEMPLATES } from '@kudesi/shared';
import { buildDataSourceOptions } from '../database/data-source';
import { Company,FlowDefinition,FlowRun,FlowStep,FlowEvent,User } from '../entities';
import { buildServices } from '../test-support';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { FlowService } from '../flow/flow.service';
import type { AuthUser } from '../common/auth.decorators';
import { importBusinessEvent } from './business-event-import';
import { legacyWallTime as wall } from './legacy-time';

const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('原业务事件只读时间线（MySQL）',()=>{
  let ds:DataSource,flow:FlowService,owner:AuthUser,actorId:number,foreignActorId:number,run:FlowRun,step:FlowStep;
  const targets=new Map<string,number>(),stamp='2026-09-01 10:00:00';
  const originalRun={id:1,company_id:3,graph_status:'batch'},originalNode={id:10,workflow_instance_id:1,owner_id:10};
  const source=(id:number,event_type:string)=>({id,company_id:3,workflow_instance_id:1,workflow_node_record_id:event_type==='batch_edit'?null:10,actor_id:20,event_type,title:'原操作标题',amount:null,created_at:stamp,payload:{before:{privateCost:123.456789},operationToken:'never-return-operation-token'}});
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();
    const svc=buildServices(ds);flow=new FlowService(ds,svc.resources,new FinanceDocumentsService(ds));
    const company=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'原业务事件',status:'active'}));
    const person=async(companyId:number,name:string)=>ds.manager.save(User,ds.manager.create(User,{companyId,name,account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:false,mustChangePassword:false}));
    const u=await person(company.id,'原申请人'),a=await person(company.id,'原实际操作人');actorId=a.id;
    owner={id:u.id,companyId:company.id,name:u.name,permissions:{isCompanyAdmin:false,allow:[],deny:[]}};
    const foreign=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'其他公司',status:'active'}));foreignActorId=(await person(foreign.id,'外公司操作人')).id;
    const steps=[...FLOW_TEMPLATES.find(t=>t.key==='sku-batch-apply')!.steps];
    const def=await ds.manager.save(FlowDefinition,ds.manager.create(FlowDefinition,{companyId:company.id,templateKey:'sku-batch-apply',version:1,status:'retired',steps,escalateUserIds:[],createdBy:u.id}));
    run=await ds.manager.save(FlowRun,ds.manager.create(FlowRun,{companyId:company.id,definitionId:def.id,templateKey:'sku-batch-apply',title:'原流程',status:'completed',requesterId:u.id,currentStepKey:null,payload:{},stepsSnapshot:steps,escalateUserIds:[],revision:1,createdAt:wall(stamp,true)!,finishedAt:wall(stamp)}));
    step=await ds.manager.save(FlowStep,ds.manager.create(FlowStep,{companyId:company.id,runId:run.id,seq:1,stepKey:'review',stepName:'原节点',stepType:'finance',status:'done',enteredVia:'normal',recipients:[u.id],handledBy:null,enteredAt:wall(stamp,true)!,finishedAt:wall(stamp)}));
    targets.set('flow_run:1',run.id);targets.set('flow_step:10',step.id);targets.set('user:20',actorId);targets.set('user:30',foreignActorId);
  });
  afterAll(async()=>{await ds?.destroy();});
  const context=(em:DataSource['manager'])=>({em,companyId:owner.companyId,sourceCompanyId:3,lookup:(type:string,id:unknown)=>targets.get(`${type}:${id}`),register:async(type:string,id:string,target:number)=>{targets.set(`${type}:${id}`,target);}});
  it('三种历史操作保留真实人和时点，原接收人不被写成操作人，不公开未分级变更JSON或令牌',async()=>{
    const counts=async()=>Promise.all(['notifications','outbox_jobs','finance_documents'].map(async t=>Number((await ds.query(`SELECT COUNT(*) n FROM ${t} WHERE company_id=?`,[owner.companyId]))[0].n)));
    const before=await counts();
    await ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;for(const [i,type] of ['batch_edit','batch_transition','batch_reassignment'].entries()){const row=source(i+1,type);expect((await importBusinessEvent(context(em),row,originalRun,originalNode)).reused).toBe(false);expect((await importBusinessEvent(context(em),row,originalRun,originalNode)).reused).toBe(true);}});
    expect(await counts()).toEqual(before);
    const detail=await flow.detail(owner,run.id);expect(detail.events).toHaveLength(3);
    expect(detail.events.every(e=>e.actorName==='原实际操作人'&&e.action==='legacy')).toBe(true);
    expect(detail.events.map(e=>e.note)).toEqual(['修改申请：原操作标题','节点办理：原操作标题','改派办理人：原操作标题']);
    expect(JSON.stringify(detail)).not.toMatch(/privateCost|123\.456789|never-return-operation-token/);
    expect((await ds.manager.findOneByOrFail(FlowStep,{id:step.id})).handledBy).toBeNull();
    expect((await ds.manager.findOneByOrFail(FlowEvent,{id:targets.get('flow_event:1')!})).createdAt).toEqual(wall(stamp));
  });
  it('跨公司操作人、缺失关联或原时点、未知类型和金额均拒绝；异常回滚不留下事件',async()=>{
    for(const patch of [{actor_id:30},{actor_id:999},{workflow_instance_id:999},{workflow_node_record_id:999},{event_type:'unknown'},{amount:'0.00'},{created_at:null}]){
      await expect(ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;return importBusinessEvent(context(em),{...source(90,'batch_transition'),...patch},originalRun,originalNode);})).rejects.toThrow();
    }
    await expect(ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;await importBusinessEvent({...context(em),register:async()=>{}},source(91,'batch_edit'),originalRun);throw Error('rollback');})).rejects.toThrow('rollback');
    expect(await ds.manager.count(FlowEvent,{where:{companyId:owner.companyId}})).toBe(3);
    await ds.manager.update(FlowEvent,{id:targets.get('flow_event:1')!},{note:'已有人核正'});
    await expect(ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;return importBusinessEvent(context(em),source(1,'batch_edit'),originalRun);})).rejects.toThrow();
    await expect(flow.detail({...owner,companyId:owner.companyId+99999},run.id)).rejects.toThrow('流程不存在');
  });
});
