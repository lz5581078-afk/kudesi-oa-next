import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { FLOW_TEMPLATES } from '@kudesi/shared';
import { buildDataSourceOptions } from '../database/data-source';
import { Company,FlowDefinition,FlowRun,FlowStep,User,WorkItem } from '../entities';
import { buildServices } from '../test-support';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { FlowService } from '../flow/flow.service';
import { TaskService } from '../flow/task.service';
import type { AuthUser } from '../common/auth.decorators';
import { importClosedTask } from './closed-task-import';
import { legacyWallTime as wall } from './legacy-time';

const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('旧已结束任务无副作用迁入（MySQL）',()=>{
  let ds:DataSource,flow:FlowService,owner:AuthUser,assignee:AuthUser,other:AuthUser,supervisor:AuthUser,run:FlowRun,step:FlowStep;
  const targets=new Map<string,number>();
  const stamp='2026-09-01 10:00:00',finished='2026-09-02 11:00:00';
  const oldRun={id:4,company_id:3,requester_id:10};
  const oldNode={id:40,workflow_instance_id:4};
  const source=(id:number,status='completed')=>({id,company_id:3,workflow_instance_id:4,workflow_node_record_id:40,source_type:'workflow',relation_type:'workflow_batch',relation_id:1,
    status,severity:'normal',assignee_id:20,supervisor_id:30,feedback_to_id:10,title:'原任务标题',completion_standard:'原完成标准',result_note:'原反馈，精度0.000001',created_at:stamp,due_at:'2026-09-02 10:00:00',completed_at:finished,submitted_at:null});
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();
    const svc=buildServices(ds);flow=new FlowService(ds,svc.resources,new FinanceDocumentsService(ds));
    const company=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'原历史任务',status:'active'}));
    const person=async(name:string,allow:string[]=[]):Promise<AuthUser>=>{const u=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,name,account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:false,mustChangePassword:false}));return {id:u.id,companyId:company.id,name,permissions:{isCompanyAdmin:false,allow,deny:[]}};};
    owner=await person('原发起人');assignee=await person('原负责人');supervisor=await person('原监督人',['flow.overview.view']);other=await person('仅可总览',['flow.overview.view']);
    for(const [old,u] of [[10,owner],[20,assignee],[30,supervisor]] as const)targets.set(`user:${old}`,u.id);
    const steps=[...FLOW_TEMPLATES.find(t=>t.key==='sku-batch-apply')!.steps];
    const def=await ds.manager.save(FlowDefinition,ds.manager.create(FlowDefinition,{companyId:company.id,templateKey:'sku-batch-apply',version:1,status:'retired',steps,escalateUserIds:[],createdBy:owner.id}));
    run=await ds.manager.save(FlowRun,ds.manager.create(FlowRun,{companyId:company.id,definitionId:def.id,templateKey:'sku-batch-apply',title:'原流程',status:'completed',requesterId:owner.id,currentStepKey:null,payload:{},stepsSnapshot:steps,escalateUserIds:[],revision:1,createdAt:wall(stamp,true)!,finishedAt:wall(finished)}));
    step=await ds.manager.save(FlowStep,ds.manager.create(FlowStep,{companyId:company.id,runId:run.id,seq:1,stepKey:'review',stepName:'原节点',stepType:'finance',status:'done',enteredVia:'normal',recipients:[assignee.id],enteredAt:wall(stamp,true)!,finishedAt:wall(finished)}));
    targets.set('flow_run:4',run.id);targets.set('flow_step:40',step.id);
  });
  afterAll(async()=>{await ds?.destroy();});
  const ctx=(em:DataSource['manager'])=>({em,companyId:owner.companyId,sourceCompanyId:3,lookup:(type:string,id:unknown)=>targets.get(`${type}:${id}`),register:async(type:string,id:string,target:number)=>{
    await em.query('INSERT INTO legacy_import_links(source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES(?,?,?,?,?,?,?)',['legacy-oa',3,owner.companyId,`${type}:${id}`,type,target,'a'.repeat(64)]);
    targets.set(`${type}:${id}`,target);
  }});
  it('保留原时间、已完成/取消及反馈；复跑不重复，无新提醒，完成记录与取消记录均可读',async()=>{
    const counts=async()=>Promise.all(['notifications','outbox_jobs'].map(async t=>Number((await ds.query(`SELECT COUNT(*) n FROM ${t} WHERE company_id=?`,[owner.companyId]))[0].n)));
    const before=await counts();
    await ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;for(const row of [source(1),source(2,'cancelled')]){expect((await importClosedTask(ctx(em),row,oldRun,oldNode)).reused).toBe(false);expect((await importClosedTask(ctx(em),row,oldRun,oldNode)).reused).toBe(true);}});
    expect(await counts()).toEqual(before);
    const detail=await flow.detail(owner,run.id);
    expect(detail.historicalTasks).toHaveLength(2);
    expect(detail.historicalTasks![0]).toMatchObject({status:'done',assigneeName:assignee.name,supervisorName:supervisor.name,submittedAt:null,doneNote:'原反馈，精度0.000001'});
    expect(detail.historicalTasks![1]).toMatchObject({status:'cancelled'});
    const task=await ds.manager.findOneByOrFail(WorkItem,{id:targets.get('work_item:1')!});
    expect(task.createdAt).toEqual(wall(stamp));expect(task.finishedAt).toEqual(wall(finished));
    const todos=await flow.todos(assignee,{tab:'done',page:1,pageSize:20});expect(todos.total).toBe(1);expect(todos.counts.pending).toBe(0);
    await expect(new TaskService(ds).complete(assignee,task.id,'再次完成')).rejects.toThrow('任务不存在');
  });
  it('总览权限不泄露他人反馈，原负责人和监督人可读，跨公司不可读',async()=>{
    expect((await flow.detail(other,run.id)).historicalTasks).toBeUndefined();
    expect((await flow.detail(assignee,run.id)).historicalTasks).toHaveLength(2);
    expect((await flow.detail(supervisor,run.id)).historicalTasks).toHaveLength(2);
    await expect(flow.detail({...owner,companyId:owner.companyId+99999},run.id)).rejects.toThrow('流程不存在');
  });
  it('未知反馈、错误归属、缺失原结束时间拒绝，不覆盖已迁后修改的资料',async()=>{
    for(const patch of [{submit_payload:{secret:'unknown'}},{feedback_to_id:20},{workflow_node_record_id:999},{completed_at:null},{company_id:999}]){
      await expect(ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;return importClosedTask(ctx(em),{...source(90),...patch},oldRun,oldNode);})).rejects.toThrow();
    }
    await ds.manager.update(WorkItem,{id:targets.get('work_item:1')!},{doneNote:'新站修改'});
    await expect(ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;return importClosedTask(ctx(em),source(1),oldRun,oldNode);})).rejects.toThrow('未覆盖');
    expect((await ds.manager.findOneByOrFail(WorkItem,{id:targets.get('work_item:1')!})).doneNote).toBe('新站修改');
  });
});
