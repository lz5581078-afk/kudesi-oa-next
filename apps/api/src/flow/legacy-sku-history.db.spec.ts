import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { FLOW_TEMPLATES } from '@kudesi/shared';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FlowDefinition, FlowRun, FlowStep, User } from '../entities';
import { buildServices } from '../test-support';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { FlowService } from './flow.service';
import { legacyWallTime as wall } from '../migration/legacy-time';
import { preserveSourceRow } from '../migration/source-rows';
import type { AuthUser } from '../common/auth.decorators';

const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('在办SKU的迁入前资料只读视图（MySQL）',()=>{
  let ds:DataSource,svc:ReturnType<typeof buildServices>,flow:FlowService;
  let owner:AuthUser,stranger:AuthUser,runId:number,originalPayload:Record<string,unknown>;
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();
    svc=buildServices(ds);flow=new FlowService(ds,svc.resources,new FinanceDocumentsService(ds));
    const company=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'旧SKU原稿',status:'active'}));
    const person=async(name:string):Promise<AuthUser>=>{
      const u=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,name,account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:false,mustChangePassword:false}));
      return {id:u.id,companyId:company.id,name,permissions:{isCompanyAdmin:false,allow:['flow.apply.view'],deny:[]}};
    };
    owner=await person('原申请人');stranger=await person('无关人');
    const oldRun={id:9000,company_id:3,graph_status:'batch',requester_id:10,status:'processing',created_at:'2026-09-01 09:00:00'};
    const oldItem={id:5,company_id:3,workflow_instance_id:9000,status:'returned',payload_json:{specName:'原规格',lines:[{baseCodeId:15,sourceCode:'OLD-15',displayName:'原物料',quantity:0.001}]}};
    const record={id:90001,workflow_instance_id:9000,node_name:'原审核记录',status:'returned',action:'return',comment:'原退回意见',created_at:'2026-09-01 10:00:00',completed_at:'2026-09-01 11:00:00',form_payload:{payload:{specName:'审核时原规格',lines:[]},inspection:{totalCost:987.654321,sources:[[15,'0.000001']]},result:{finalCode:'OLD-RESULT',sync:[{id:15,status:'done',message:'private-sync-result'}]},duplicateConfirmation:{actorId:20,confirmedAt:'2026-09-01',token:'never-public-confirmation',reason:'原确认',matches:[]}}};
    await ds.transaction(async em=>{
      const steps=FLOW_TEMPLATES.find(t=>t.key==='sku-batch-apply')!.steps;
      const def=await em.save(FlowDefinition,em.create(FlowDefinition,{companyId:company.id,templateKey:'sku-batch-apply',version:1,status:'retired',steps:[...steps],escalateUserIds:[],createdBy:owner.id,publishedAt:null,publishedBy:null}));
      originalPayload={batchName:'当前申请',specs:[],_legacySkuItemId:'5'};
      const run=await em.save(FlowRun,em.create(FlowRun,{companyId:company.id,definitionId:def.id,templateKey:'sku-batch-apply',title:'当前办理申请',status:'running',requesterId:owner.id,currentStepKey:'apply',payload:originalPayload,stepsSnapshot:[...steps],escalateUserIds:[],revision:7,createdAt:wall(oldRun.created_at,true)!}));runId=run.id;
      await em.query('INSERT INTO legacy_import_links(source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES(?,?,?,?,?,?,?)',['legacy-oa',3,company.id,'user:10','user',owner.id,'0'.repeat(64)]);
      const past=await em.save(FlowStep,em.create(FlowStep,{companyId:company.id,runId,seq:1,stepKey:'review',stepName:'原审核记录',stepType:'finance',status:'returned',enteredVia:'normal',recipients:[owner.id],handledBy:null,action:'return',comment:'原退回意见',enteredAt:wall(record.created_at,true)!,finishedAt:wall(record.completed_at)}));
      await em.save(FlowStep,em.create(FlowStep,{companyId:company.id,runId,seq:2,stepKey:'apply',stepName:'当前修改',stepType:'submit',status:'active',enteredVia:'return',recipients:[owner.id],enteredAt:wall(record.completed_at,true)!}));
      for(const [table,row] of [['workflow_instances',oldRun],['workflow_batch_items',oldItem],['workflow_node_records',record]] as const){
        const stored=await preserveSourceRow(em,svc.crypto,{companyId:company.id,sourceCompanyId:3,table,key:String(row.id)},row);
        const type=table==='workflow_instances'?'flow_run':table==='workflow_node_records'?'flow_step':null;
        if(type)await em.query('INSERT INTO legacy_import_links(source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES(?,?,?,?,?,?,?)',['legacy-oa',3,company.id,`${type}:${row.id}`,type,type==='flow_run'?runId:past.id,stored.hash]);
      }
      await preserveSourceRow(em,svc.crypto,{companyId:company.id,sourceCompanyId:3,table:'workflow_batch_items',key:'6'},{...oldItem,id:6,workflow_instance_id:9999,payload_json:{specName:'另一申请的资料'}});
    });
  });
  afterAll(async()=>{await ds?.destroy();});
  it('原稿与当前可编辑申请分开；成本/同步分别鉴权，确认令牌永不返回',async()=>{
    const base=await flow.detail(owner,runId);
    expect(base.payload).toEqual({batchName:'当前申请',specs:[]});
    expect(base.fields.some(f=>f.key==='legacySkuPayload')).toBe(false);
    expect(base.legacyHistory).toMatchObject({sourceRunId:'9000',status:'processing',itemStatus:'returned'});
    expect(base.legacyHistory!.request!.values.legacySkuPayload).toContain('原规格');
    expect(base.legacyHistory!.steps[0]).toMatchObject({name:'原审核记录',comment:'原退回意见'});
    expect(JSON.stringify(base)).not.toMatch(/987\.654321|0\.000001|private-sync-result|never-public-confirmation/);
    const cost=await flow.detail({...owner,permissions:{...owner.permissions,allow:['product.cost.view']}},runId);
    expect(JSON.stringify(cost.legacyHistory)).toContain('987.654321');
    expect(JSON.stringify(cost.legacyHistory)).not.toMatch(/private-sync-result|never-public-confirmation/);
    const sync=await flow.detail({...owner,permissions:{...owner.permissions,allow:['finance.bundle-sync.manage']}},runId);
    expect(JSON.stringify(sync.legacyHistory)).toContain('private-sync-result');
    expect(JSON.stringify(sync.legacyHistory)).not.toMatch(/987\.654321|never-public-confirmation/);
  });
  it('无关人和跨公司先被流程权限挡住；伪造原稿编号不能借用同公司的其他原记录',async()=>{
    await expect(flow.detail(stranger,runId)).rejects.toThrow('没有查看');
    await expect(flow.detail({...owner,companyId:owner.companyId+99999},runId)).rejects.toThrow('流程不存在');
    await ds.manager.update(FlowRun,{id:runId,companyId:owner.companyId},{payload:{...originalPayload,_legacySkuItemId:'6'}});
    await expect(flow.detail(owner,runId)).rejects.toThrow('完整性核对失败');
    const restored=await ds.manager.findOneByOrFail(FlowRun,{id:runId,companyId:owner.companyId});restored.payload=originalPayload;await ds.manager.save(FlowRun,restored);
    expect((await flow.detail(owner,runId)).legacyHistory!.request!.values.legacySkuPayload).toContain('原规格');
  });
});
