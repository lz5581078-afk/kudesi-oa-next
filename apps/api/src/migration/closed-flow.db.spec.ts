import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FlowRun, FlowStep, User, WorkItem } from '../entities';
import { buildServices } from '../test-support';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import type { AuthUser } from '../common/auth.decorators';
import { importClosedFlow } from './closed-flow-import';
import type { LegacyWorkflowSource } from './protocol';

const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('结束流程的只读原时间线（MySQL）',()=>{
  let ds:DataSource,svc:ReturnType<typeof buildServices>,flow:FlowService,admin:AuthUser,requester:AuthUser,owner:AuthUser,stranger:AuthUser;
  let serial=7000;
  const persisted=new Map<string,number>();
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();
    svc=buildServices(ds);flow=new FlowService(ds,svc.resources,new FinanceDocumentsService(ds));
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'历史测试',status:'active'}));
    const user=async(name:string,isCompanyAdmin=false)=>{
      const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,name,account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin,mustChangePassword:false}));
      return {id:u.id,companyId:c.id,name,permissions:{isCompanyAdmin,allow:['flow.apply.view','workbench.started.view','flow.templates.manage'],deny:[]}};
    };
    admin=await user('管理员',true);requester=await user('原申请人');owner=await user('原接收人');stranger=await user('无关人');
  });
  afterAll(async()=>{await ds?.destroy();});
  function fixture(){
    const id=++serial;
    const row={id,company_id:3,requester_id:10,template_id:9,title:'原已结束申请'+id,status:'completed',graph_status:'batch',created_at:'2026-09-01 09:00:00',completed_at:'2026-09-02 15:00:00',due_at:'2026-09-02 18:00:00'};
    const records=[
      {id:id*10,workflow_instance_id:id,node_name:'发起',node_type:'submit',owner_id:10,action:'submit',status:'completed',is_active:0,created_at:row.created_at,completed_at:row.created_at,form_payload:{payload:{purchasePrice:12345,password:'never-expose-original-form'}},timing_json:{}},
      {id:id*10+1,workflow_instance_id:id,node_name:'原审批',node_type:'finance',owner_id:20,action:'approve',status:'completed',is_active:0,created_at:'2026-09-02 10:00:00',completed_at:row.completed_at,form_payload:{inspection:{costSnapshot:54321}},timing_json:{}},
    ];
    const source:LegacyWorkflowSource={companyId:3,tables:{workflow_instances:[row],workflow_node_records:records,workflow_templates:[{id:9,name:'原SKU申请'}]}};
    return {row,records,source};
  }
  async function project(f:ReturnType<typeof fixture>){
    const ids=new Map<string,number>([...persisted,['user:10',requester.id],['user:20',owner.id]]);
    const result=await ds.transaction(async em=>{
      em.queryRunner!.data.legacyImport=true;
      return importClosedFlow({em,companyId:admin.companyId,sourceCompanyId:3,actorId:admin.id,lookup:(type,id)=>ids.get(`${type}:${id}`),register:async(type,id,target)=>{ids.set(`${type}:${id}`,target);}},f.source,f.row);
    });
    for(const [k,v] of ids)persisted.set(k,v);
    return result;
  }
  it('原状态/时间/动作可查；接收人不冒充审核人，不泄露未分级的原始表单，不产生任务或通知',async()=>{
    const f=fixture();const {runId}=await project(f);
    const detail=await flow.detail(requester,runId);
    expect(detail.status).toBe('completed');expect(detail.createdAt.toISOString()).toBe('2026-09-01T01:00:00.000Z');expect(detail.finishedAt!.toISOString()).toBe('2026-09-02T07:00:00.000Z');
    expect(detail.steps[1]).toMatchObject({recipients:['原接收人'],handledByName:null,action:null,form:{legacyStatus:'completed',legacyAction:'approve'}});
    expect(JSON.stringify(detail)).not.toMatch(/12345|54321|never-expose-original-form|costSnapshot|purchasePrice/);
    expect(detail.activeStep).toBeNull();expect(detail.events).toEqual([]);expect(Object.values(detail.me).some(v=>v===true)).toBe(false);
    expect((await flow.detail(owner,runId)).id).toBe(runId);
    await expect(flow.detail(stranger,runId)).rejects.toThrow('没有查看');
    await expect(flow.detail({...admin,companyId:admin.companyId+99999},runId)).rejects.toThrow('流程不存在');
    expect(await ds.manager.count(WorkItem,{where:{companyId:admin.companyId,runId}})).toBe(0);
    expect(Number((await ds.query('SELECT COUNT(*) n FROM outbox_jobs WHERE company_id=?',[admin.companyId]))[0].n)).toBe(0);
    await expect(flow.saveDraft(admin,'legacy-history',[],[])).rejects.toThrow('仅供查看');
  });
  it('拒绝活节点、缺结束时间或未映射人员；不会把未完成流程强制归档',async()=>{
    const f=fixture();f.records[1].is_active=1;
    await expect(project(f)).rejects.toThrow('活节点');
    f.records[1].is_active=0;f.row.completed_at='';
    await expect(project(f)).rejects.toThrow('缺少原始时间');
    f.row.completed_at='2026-09-02 15:00:00';f.records[1].owner_id=999;
    await expect(project(f)).rejects.toThrow('人员未迁入');
    expect(await ds.manager.count(FlowRun,{where:{companyId:admin.companyId,title:f.row.title}})).toBe(0);
    expect(await ds.manager.count(FlowStep,{where:{companyId:admin.companyId,stepName:'原审批'}})).toBe(1);
  });
});
