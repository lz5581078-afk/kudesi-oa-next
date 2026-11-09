import {BundleToolsService} from './bundle-tools.service';
import {OutboxService} from '../outbox/outbox.service';
import {bundleCompositionToken} from './bundle-revision-facts';
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, OutboxJob, ResourceChangeLog, ResourceLink, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import type { ResourcesService } from './resources.service';
import { CostService } from './cost.service';
import { withTrustedResourceImport } from './resource-import-capability';

const db=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
db('直接档案 BOM 沿统一修订与验证发布（隔离 MySQL）',()=>{
 let ds:DataSource,resources:ResourcesService;
 beforeAll(async()=>{ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME ?? 'kudesi_oa_test_finance_parity_phase72_final'}),migrationsRun:true} as never);await ds.initialize();resources=buildServices(ds).resources;});
 afterAll(async()=>{await ds?.destroy();});
 const fixture=async()=>{
  const company=await ds.manager.save(Company,ds.manager.create(Company,{name:'合成档案修订公司',code:crypto.randomBytes(8).toString('hex'),status:'active'}));
  const person=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,name:'合成修订员',account:'synthetic',passwordHash:'unused',status:'active',isCompanyAdmin:true,mustChangePassword:false}));
  const user:AuthUser={id:person.id,companyId:company.id,name:person.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
  const category=await resources.create(user,'finance-categories',{archiveType:'raw',name:'合成真实原料分类',code:'RAW'});
  const makeProduct=(name:string,price:number,weight:number)=>resources.create(user,'finance-products',{archiveType:'raw',name,categoryId:category.id,purchaseSpec:'千克',specQty:1,specUnit:'KG',purchasePrice:price,freight:10,handlingFee:20,weightManual:true,weightG:weight});
  const main=await makeProduct('合成主商品',500.4567,1000),first=await makeProduct('合成档案一',100.1234,1000),second=await makeProduct('合成档案二',182.5681,1234.567);
  const base=await resources.create(user,'finance-base-codes',{productId:main.id});await resources.changeStatus(user,'finance-base-codes',base.id,'verified');
  const platform=await resources.create(user,'finance-platforms',{name:'合成修订平台',code:'REV'}),scenario=await resources.create(user,'finance-scenarios',{name:'标准销售',code:'standard'}),bundleCategory=await resources.create(user,'finance-categories',{archiveType:'bundle',name:'合成组合分类',code:'BDL'});
  let bundle!:ResourceRecord;
  await ds.transaction(em=>withTrustedResourceImport(em,user,'bundle_codes',async()=>{
   bundle=await resources.createRecord(em,user,'finance-bundles',{platformId:platform.id,scenarioId:scenario.id,bundleCategoryId:bundleCategory.id,manualCode:'Direct_Revision+1',manualStyleCode:'Direct_Style+1',manualName:'合成直接档案组合',manualShortName:'合成组合',manualPropertiesValue:'合成规格',manualReason:'合成原文件导入',baseUnit:'千克'});
   await resources.createRecord(em,user,'finance-bundle-lines',{bundleId:bundle.id,baseCodeId:base.id,role:'main',qty:1,unit:'KG',includeInJst:true});
   await resources.createRecord(em,user,'finance-bundle-lines',{bundleId:bundle.id,productId:first.id,role:'package',qty:1,unit:'KG',includeInJst:false});
  }));
  await resources.changeStatus(user,'finance-bundles',bundle.id,'verified');
  const lines=async()=>ds.manager.find(ResourceRecord,{where:{companyId:user.companyId,type:'finance-bundle-lines'},order:{id:'ASC'}});
  const payload=async(productId=second.id)=> (await lines()).map(line=>({...line.data,...(line.data.productId?{productId,qty:2.345,lossRate:1.2345,isRequired:false,costTreatment:'reference_only',note:'保留真实档案控制列'}:{})}));
  const envelope=async(input:Array<Record<string,unknown>>,weight?:{mode:'auto'|'manual';grams:number})=>JSON.stringify({version:1,sourceToken:bundleCompositionToken(await ds.manager.findOneByOrFail(ResourceRecord,{id:bundle.id,companyId:user.companyId}),await lines()),lines:input,...(weight?{weight}:{})});
  return{user,category,main,first,second,base,bundle,lines,payload,envelope};
 };
 it('直接档案修订发布保留productId与控制列、六位元报价精度、同一验证事务和BOM版本',async()=>{
  const f=await fixture();const revision=await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'真实档案替换并修订数量',payload:await f.envelope((await f.payload()).map(line=>line.productId?{...line,role:'main',cost:999999,unitCost:999999}:line))});
  expect(JSON.parse(String(revision.data.payload)).lines.find((line:{productId?:number})=>line.productId)).not.toHaveProperty('cost');
  expect((await f.lines()).find(line=>line.data.productId)?.data.productId).toBe(f.first.id);
  await resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified');
  const lines=await f.lines(),direct=lines.find(line=>line.data.productId)!;
  expect(direct.data).toMatchObject({productId:f.second.id,role:'main',qty:2.345,lossRate:1.2345,isRequired:false,includeInJst:false,costTreatment:'reference_only'});expect(direct.data.baseCodeId).toBeUndefined();
  expect((await resources.get(f.user,'finance-bundle-revisions',revision.id)).status).toBe('published');
  const fresh=await resources.get(f.user,'finance-bundles',f.bundle.id);expect(fresh).toMatchObject({status:'verified',data:{bomVersion:'V02'}});expect(fresh.data.pendingRevisionId).toBeUndefined();
  const cost=new CostService(ds),data=await cost.load(f.user.companyId),row=cost.row(data,data.bundles.find(bundle=>bundle.id===f.bundle.id)!);
  // 真24 0054 cost_price DECIMAL(18,4)：档案530.4567分先落镜像530.46分；直接档案行不走该镜像。
  expect((await resources.get(f.user,'finance-products',f.main.id)).data.totalCost).toBe(530.4567);
  expect((await resources.get(f.user,'finance-base-codes',f.base.id)).data.cost).toBe(530.46);
  // 530.46 + 212.5681 × 2.345 = 1028.9321945 分，组合末尾一次舍入至六位元。
  expect(row.preShipCostCents).toBe(1028.9322);expect(row.weightG).toBe(3895.059615);
  const product=await resources.get(f.user,'finance-products',f.second.id);
  expect(JSON.parse(String(fresh.data.snapshot)).lines.find((line:{ref:string})=>line.ref===product.data.code)).toMatchObject({qty:2.345,cost:212.5681,weightG:1234.567});
 });
 it('不同档案ID参与来源token，价格同为真实事实也不能被迟到修订混同',async()=>{
  const f=await fixture();await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'等待验证的修订',payload:await f.envelope(await f.payload())});
  const line=(await f.lines()).find(line=>line.data.productId)!;
  await ds.manager.update(ResourceRecord,{id:line.id,companyId:f.user.companyId},{data:{...line.data,productId:f.second.id}});
  await expect(resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified')).rejects.toThrow(/构成又被改过/);
  expect((await f.lines()).find(line=>line.data.productId)?.data.productId).toBe(f.second.id);
 });
 it('普通请求/runner伪造发布标记不能绕过公司/启用/末级资料校验',async()=>{
  const f=await fixture(),foreign=await fixture();
  await expect(resources.create(f.user,'finance-bundle-lines',{bundleId:f.bundle.id,productId:foreign.first.id,role:'package',qty:1,unit:'KG',publishing:true})).rejects.toThrow(/不存在/);
  await expect(ds.transaction(async em=>{em.queryRunner!.data.publishing=true;await resources.createRecord(em,f.user,'finance-bundle-lines',{bundleId:f.bundle.id,productId:foreign.first.id,role:'package',qty:1,unit:'KG'});})).rejects.toThrow(/不存在/);
  await expect(resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'跨公司档案不可用',payload:await f.envelope(await f.payload(foreign.second.id))})).rejects.toThrow(/不存在/);
  await resources.changeStatus(f.user,'finance-products',f.second.id,'inactive','合成停用');
  await expect(resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'停用档案不可用',payload:await f.envelope(await f.payload())})).rejects.toThrow(/停用/);
  await ds.manager.update(ResourceRecord,{id:f.second.id,companyId:f.user.companyId},{status:'active'});
  await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:f.user.companyId,type:'finance-categories',title:'合成非法下级',status:'active',data:{archiveType:'raw',name:'合成非法下级',code:'CHILD',parentId:f.category.id},searchText:'',createdBy:f.user.id,updatedBy:f.user.id}));
  await expect(resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'非末级档案不可用',payload:await f.envelope(await f.payload())})).rejects.toThrow(/末级/);
 });
 it('发布中途失败整组回滚旧行/引用/修订/审计，移除内部作用域后可重试',async()=>{
  const f=await fixture();const revision=await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'模拟发布失败回滚',payload:await f.envelope(await f.payload())});
  const before=await f.lines(),record=await resources.get(f.user,'finance-bundles',f.bundle.id),links=await ds.manager.find(ResourceLink,{where:{companyId:f.user.companyId},order:{id:'ASC'}}),logs=await ds.manager.count(ResourceChangeLog,{where:{companyId:f.user.companyId}});
  const original=resources.createRecord.bind(resources);let inserted=0;
  const spy=jest.spyOn(resources,'createRecord').mockImplementation(async(em,user,type,values,note,status)=>{if(type==='finance-bundle-lines' && note==='发布构成修订' && ++inserted===2)throw new Error('合成第二行发布失败');return original(em,user,type,values,note,status);});
  try{await expect(resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified')).rejects.toThrow('合成第二行发布失败');}finally{spy.mockRestore();}
  expect(inserted).toBe(2);expect(await f.lines()).toEqual(before);expect(await resources.get(f.user,'finance-bundles',f.bundle.id)).toEqual(record);
  expect(await ds.manager.find(ResourceLink,{where:{companyId:f.user.companyId},order:{id:'ASC'}})).toEqual(links);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:f.user.companyId}})).toBe(logs);expect((await resources.get(f.user,'finance-bundle-revisions',revision.id)).status).toBe('pending');
  await resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified');expect((await resources.get(f.user,'finance-bundle-revisions',revision.id)).status).toBe('published');
 });
 it('手工重量随修订核对及发布，最后一步失败时BOM/重量/身份/日志整组回滚',async()=>{
  const f=await fixture(),tools=new BundleToolsService(ds,resources,{} as OutboxService),before=await resources.get(f.user,'finance-bundles',f.bundle.id);
  const revision=await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'合成精确手工重量',payload:await f.envelope(await f.payload(),{mode:'manual',grams:1234.567891})});
  expect(JSON.parse(String(revision.data.payload)).weight).toEqual({mode:'manual',grams:1234.567891});
  const report=await tools.report(f.user,f.bundle.id);expect(report.totalWeightG).toBe(1234.567891);
  const pending=await resources.get(f.user,'finance-bundles',f.bundle.id),lines=await f.lines(),logs=await ds.manager.count(ResourceChangeLog,{where:{companyId:f.user.companyId}});
  const original=resources.setStatusDirect.bind(resources),spy=jest.spyOn(resources,'setStatusDirect').mockImplementation(async(em,user,type,id,status,note)=>{if(type==='finance-bundle-revisions'&&status==='published')throw new Error('合成最后发布失败');return original(em,user,type,id,status,note);});
  try{await expect(resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified')).rejects.toThrow('合成最后发布失败');}finally{spy.mockRestore();}
  expect(await resources.get(f.user,'finance-bundles',f.bundle.id)).toEqual(pending);expect(await f.lines()).toEqual(lines);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:f.user.companyId}})).toBe(logs);
  await resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified');const after=await resources.get(f.user,'finance-bundles',f.bundle.id);
  expect(after.data).toMatchObject({weightMode:'manual',manualWeightG:1234.567891});for(const key of ['code','styleCode','name','shortName','mainStyleCode'])expect(after.data[key]).toBe(before.data[key]);
  expect(report.outbound.sku_id).toBe(after.data.code);expect(JSON.parse(String(after.data.snapshot)).breakdown.weightG).toBe(1234.567891);
 });
 it('完整来源token覆盖备注等控制列；旧读取或伪造token不可提交，提交后再变更不可发布',async()=>{
  const f=await fixture(),tools=new BundleToolsService(ds,resources,{} as OutboxService),ctx=await tools.composition(f.user,f.bundle.id),input=await f.payload();
  const first=(await f.lines())[0];await resources.update(f.user,'finance-bundle-lines',first.id,{note:'真实并发备注修改'});
  await expect(tools.createRevision(f.user,f.bundle.id,'迟到的组成修改',input as never,{sourceToken:ctx.sourceToken})).rejects.toThrow(/已变化/);
  await expect(tools.createRevision(f.user,f.bundle.id,'伪造来源令牌',input as never,{sourceToken:'0'.repeat(64)})).rejects.toThrow(/已变化/);
  const revision=await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'最新来源的修改',payload:await f.envelope(await f.payload())});
  await resources.update(f.user,'finance-bundle-lines',first.id,{isRequired:false});await expect(resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified')).rejects.toThrow(/构成又被改过/);
  expect((await resources.get(f.user,'finance-bundle-revisions',revision.id)).status).toBe('pending');
 });
 it('新增直接材料走真实资料与价格，自动重量不采信客户端，权限与上传约束不可绕过',async()=>{
  const f=await fixture(),tools=new BundleToolsService(ds,resources,{} as OutboxService);
  const extra=await resources.create(f.user,'finance-bundle-lines',{bundleId:f.bundle.id,productId:f.second.id,role:'label',qty:0.123456,includeInJst:false});expect(extra.data.productId).toBe(f.second.id);
  await expect(resources.create(f.user,'finance-bundle-lines',{bundleId:f.bundle.id,productId:f.second.id,baseCodeId:f.base.id,role:'package',qty:1,includeInJst:false})).rejects.toThrow(/一种/);
  await expect(resources.create(f.user,'finance-bundle-lines',{bundleId:f.bundle.id,productId:f.second.id,role:'package',qty:1,includeInJst:true})).rejects.toThrow(/基础编码/);
  const noCost:AuthUser={...f.user,permissions:{isCompanyAdmin:false,allow:['resource.finance-bundles.view','resource.finance-bundles.edit','resource.finance-bundles.create'],deny:['product.cost.edit','product.cost.view']}};
  await expect(resources.create(noCost,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'未授权修改重量',payload:await f.envelope(await f.payload(),{mode:'manual',grams:1234.5})})).rejects.toThrow(/手工重量/);
  const payload=(await f.payload()).map(line=>({...line,cost:999999,unitCost:999999,totalCost:999999}));
  const revision=await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'自动重量取真实资料',payload:await f.envelope(payload,{mode:'auto',grams:1})});
  const stored=JSON.parse(String(revision.data.payload));expect(stored.weight.grams).not.toBe(1);expect(stored.lines.every((line:Record<string,unknown>)=>line.cost===undefined&&line.unitCost===undefined&&line.totalCost===undefined)).toBe(true);
  const safe=JSON.stringify(await tools.composition(noCost,f.bundle.id));expect(safe).not.toContain('purchasePrice');expect(safe).not.toContain('totalCost');expect(safe).not.toContain('snapshot');
 });
 it('200项真实材料加1项人工可完整保存及发布，不截断第201项',async()=>{
  const f=await fixture(),template=await ds.manager.findOneByOrFail(ResourceRecord,{id:f.second.id}),materials:ResourceRecord[]=[];
  for(let index=0;index<199;index++)materials.push(await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:f.user.companyId,type:'finance-products',title:'合成批量材料'+index,status:'active',data:{...template.data,code:'SYN-M-'+index},uniqueKey:'syn-m-'+index,searchText:'合成批量材料',createdBy:f.user.id,updatedBy:f.user.id})));
  const version=await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:f.user.companyId,type:'finance-labor-versions',title:'合成有效版本',status:'active',data:{name:'合成有效版本'},searchText:'',createdBy:f.user.id,updatedBy:f.user.id}));
  const labor=await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:f.user.companyId,type:'finance-labor-costs',title:'合成人工201',status:'active',data:{versionId:version.id,workName:'合成人工201',workCode:'L201',unitName:'元/件',unitPrice:100},searchText:'',createdBy:f.user.id,updatedBy:f.user.id}));
  const input=[{role:'main',baseCodeId:f.base.id,qty:1,includeInJst:true},...materials.map(product=>({role:'package',productId:product.id,qty:1.123456,includeInJst:false})),{role:'labor',laborId:labor.id,qty:1.654321}];
  const revision=await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'合成201项实际闭环',payload:await f.envelope(input,{mode:'auto',grams:1})});expect(JSON.parse(String(revision.data.payload)).lines).toHaveLength(201);
  await resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified');const saved=await f.lines();expect(saved).toHaveLength(201);expect(saved[200].data).toMatchObject({role:'labor',laborId:labor.id,qty:1.654321});
  const history=(await resources.get(f.user,'finance-bundle-revisions',revision.id)).data.payload;expect(JSON.parse(String(history)).lines).toHaveLength(201);
 },120000);

 it('已存Array修订保持原格式、无重量事实不回填，新的裸Array请求不能省略来源令牌',async()=>{
  const f=await fixture(),tools=new BundleToolsService(ds,resources,{} as OutboxService);
  await resources.update(f.user,'finance-bundles',f.bundle.id,{weightMode:'manual',manualWeightG:888.123456,overrideReason:'合成已存手工事实'});
  const revision=await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'合成旧Array格式',payload:await f.envelope(await f.payload())});
  const current=await f.lines(),oldPayload=JSON.stringify(JSON.parse(String(revision.data.payload)).lines),oldToken=crypto.createHash('sha256').update(current.map(row=>`${row.data.role}:${row.data.role==='labor'?`L${row.data.laborId}`:typeof row.data.productId==='number'?`P${row.data.productId}`:row.data.baseCodeId}:${row.data.qty}`).sort().join('|')).digest('hex').slice(0,24);
  const stored=await ds.manager.findOneByOrFail(ResourceRecord,{id:revision.id});await ds.manager.update(ResourceRecord,{id:stored.id},{data:{...stored.data,payload:oldPayload,sourceToken:oldToken}});
  const context=await tools.composition(f.user,f.bundle.id);expect(context.pending).not.toHaveProperty('weightG');expect(context.pending).not.toHaveProperty('weightMode');expect((await resources.get(f.user,'finance-bundle-revisions',revision.id)).data.payload).toBe(oldPayload);
  await resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified');expect((await resources.get(f.user,'finance-bundles',f.bundle.id)).data).toMatchObject({weightMode:'manual',manualWeightG:888.123456});expect((await resources.get(f.user,'finance-bundle-revisions',revision.id)).data.payload).toBe(oldPayload);
  await expect(resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'伪装旧数组请求',payload:oldPayload,sourceToken:'0'.repeat(64)})).rejects.toThrow(/来源令牌/);
 });

 it('草稿之后出现同公司同步任务则发布前拒绝，未改变BOM/重量/历史，任务结束可重试',async()=>{
  const f=await fixture(),revision=await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'等待实际同步后发布',payload:await f.envelope(await f.payload(),{mode:'manual',grams:2345.678901})});
  const before=await resources.get(f.user,'finance-bundles',f.bundle.id),lines=await f.lines(),logs=await ds.manager.count(ResourceChangeLog,{where:{companyId:f.user.companyId}});
  const job=await ds.manager.save(OutboxJob,ds.manager.create(OutboxJob,{companyId:f.user.companyId,channel:'jushuitan',kind:'bundle_upsert',resourceType:'finance-bundles',resourceId:f.bundle.id,idempotencyKey:crypto.randomBytes(12).toString('hex'),payloadJson:{},status:'pending',nextAttemptAt:new Date()}));
  await expect(resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified')).rejects.toThrow(/同步任务/);
  expect(await resources.get(f.user,'finance-bundles',f.bundle.id)).toEqual(before);expect(await f.lines()).toEqual(lines);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:f.user.companyId}})).toBe(logs);expect((await resources.get(f.user,'finance-bundle-revisions',revision.id)).status).toBe('pending');
  await ds.manager.update(OutboxJob,{id:job.id},{status:'done'});await resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified');expect((await resources.get(f.user,'finance-bundles',f.bundle.id)).data.manualWeightG).toBe(2345.678901);
 });
 it('真实来源单位只读元数据不泄价格；未生效与未确认零价人工不能进入修订',async()=>{
  const f=await fixture(),tools=new BundleToolsService(ds,resources,{} as OutboxService),base=await ds.manager.findOneByOrFail(ResourceRecord,{id:f.base.id}),product=await ds.manager.findOneByOrFail(ResourceRecord,{id:Number(base.data.productId)});
  await ds.manager.update(ResourceRecord,{id:product.id},{data:{...product.data,purchaseSpec:'一袋'}});
  const material=await ds.manager.findOneByOrFail(ResourceRecord,{id:f.first.id});
  await ds.manager.update(ResourceRecord,{id:material.id},{data:{...material.data,purchaseSpec:'500克/袋'}});
  const labels=await tools.composition(f.user,f.bundle.id);
  expect(labels.baseUnits[f.base.id]).toMatchObject({unit:'KG',label:'一袋'});
  expect(labels.facts[`base:${f.base.id}`].unit).toBe('一袋');
  expect(labels.facts[`archive:${f.first.id}`].unit).toBe('500克/袋');
  expect(labels.lines).toEqual(expect.arrayContaining([expect.objectContaining({productId:f.first.id,unit:'KG'})]));
  await ds.manager.save(ResourceRecord,material);
  const data={...product.data};delete data.specUnit;await ds.manager.update(ResourceRecord,{id:product.id},{data:{...data,purchaseSpec:'张'}});
  const context=await tools.composition(f.user,f.bundle.id);expect(context.baseUnits[f.base.id]).toMatchObject({unit:'张',available:true});expect(JSON.stringify(context.baseUnits)).not.toMatch(/purchasePrice|totalCost|unitPrice/);
  const noBase:AuthUser={...f.user,permissions:{isCompanyAdmin:false,allow:['resource.finance-bundles.view'],deny:['resource.finance-base-codes.view','product.cost.view']}};expect((await tools.composition(noBase,f.bundle.id)).baseUnits).toEqual({});
  await ds.manager.save(ResourceRecord,product);
  const version=await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:f.user.companyId,type:'finance-labor-versions',title:'合成未到期版本',status:'active',data:{name:'未到期',effectiveFrom:'2999-01-01'},createdBy:f.user.id,updatedBy:f.user.id}));
  const labor=await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:f.user.companyId,type:'finance-labor-costs',title:'合成人工',status:'active',data:{versionId:version.id,workName:'合成人工',unitName:'元/件',unitPrice:100},createdBy:f.user.id,updatedBy:f.user.id}));
  const input=[...(await f.payload()),{role:'labor',laborId:labor.id,qty:1}];
  await expect(resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'未到期人工不可用',payload:await f.envelope(input)})).rejects.toThrow(/有效/);
  await ds.manager.update(ResourceRecord,{id:version.id},{data:{name:'合成当前版本'}});await ds.manager.update(ResourceRecord,{id:labor.id},{data:{...labor.data,unitPrice:0}});
  await expect(resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'零人工不能假确认',payload:await f.envelope(input)})).rejects.toThrow(/零人工/);
 });

 it('同一来源令牌并发提交只有一个草稿生效，另一请求不留下修订/审计/控制标记',async()=>{
  const f=await fixture(),payload=await f.envelope(await f.payload()),results=await Promise.allSettled(['合成并发甲','合成并发乙'].map(reason=>resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason,payload})));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
  const revisions=await ds.manager.find(ResourceRecord,{where:{companyId:f.user.companyId,type:'finance-bundle-revisions'}});expect(revisions).toHaveLength(1);expect(revisions[0].status).toBe('pending');expect((await resources.get(f.user,'finance-bundles',f.bundle.id)).data.pendingRevisionId).toBe(revisions[0].id);
  const logs=await ds.manager.find(ResourceChangeLog,{where:{companyId:f.user.companyId,resourceType:'finance-bundle-revisions'}});expect(logs.filter(log=>log.resourceId===revisions[0].id&&log.action==='create')).toHaveLength(1);expect(logs.filter(log=>log.resourceId===revisions[0].id&&log.action==='update')).toHaveLength(1);expect(revisions[0].data.bomVersionId).toEqual(expect.any(Number));expect(await ds.manager.count(ResourceRecord,{where:{companyId:f.user.companyId,type:'finance-bundle-bom-versions'}})).toBe(2);
 });

 it('统一资源真正新建人工仅有unitId也能进入组成修订、核对、发布与只读显示',async()=>{
  const f=await fixture(),tools=new BundleToolsService(ds,resources,{} as OutboxService);
  const version=await resources.create(f.user,'finance-labor-versions',{versionCode:'SYN-REAL',versionName:'合成真实录入版本'}),category=await resources.create(f.user,'finance-labor-categories',{versionId:version.id,name:'合成归档目录'}),workType=await resources.create(f.user,'finance-labor-work-types',{name:'合成包装作业'}),unit=await resources.create(f.user,'finance-labor-units',{name:'元/件'});
  const labor=await resources.create(f.user,'finance-labor-costs',{versionId:version.id,archiveCategoryId:category.id,workTypeId:workType.id,unitId:unit.id,workName:'合成实际装袋',unitPrice:100.1234});expect(labor.data.unitName).toBeUndefined();expect(labor.data.unitId).toBe(unit.id);await resources.changeStatus(f.user,'finance-labor-versions',version.id,'active');
  const revision=await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'正常录入人工参与组成',payload:await f.envelope([...(await f.payload()),{role:'labor',laborId:labor.id,qty:1.654321}],{mode:'auto',grams:1})});
  const report=await tools.report(f.user,f.bundle.id);expect(report.components.find(row=>row.role==='labor')).toMatchObject({qty:1.654321,cost:100.1234,unit:'元/件'});
  await resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified');expect((await resources.get(f.user,'finance-bundle-revisions',revision.id)).status).toBe('published');expect((await f.lines()).find(line=>line.data.laborId===labor.id)?.data.qty).toBe(1.654321);
  const context=await tools.composition(f.user,f.bundle.id);expect(context.facts['labor:'+labor.id]).toMatchObject({title:'合成实际装袋',unit:'元/件',available:true});expect((await resources.get(f.user,'finance-labor-costs',labor.id)).data.unitName).toBeUndefined();
  const other=await fixture(),foreignUnit=await resources.create(other.user,'finance-labor-units',{name:'元/外部件'}),saved=await ds.manager.findOneByOrFail(ResourceRecord,{id:labor.id});await ds.manager.update(ResourceRecord,{id:labor.id},{data:{...saved.data,unitId:foreignUnit.id,unitName:'伪装已有单位'}});
  const input=(await f.lines()).map(line=>({...line.data,...(line.data.laborId?{qty:2}:{} )}));await expect(resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'跨公司单位不可回退文本',payload:await f.envelope(input)})).rejects.toThrow(/计价单位/);
 });

 it('通用资源入口的null/数组/标量组成行统一业务400，拒绝后不留草稿/BOM/审计',async()=>{
  const f=await fixture(),payload=JSON.parse(await f.envelope(await f.payload())),before=await resources.get(f.user,'finance-bundles',f.bundle.id),lines=await f.lines(),logs=await ds.manager.count(ResourceChangeLog,{where:{companyId:f.user.companyId}});
  for(const invalid of [null,[],1,'伪造的行'])await expect(resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'合成非法行结构',payload:JSON.stringify({...payload,lines:[invalid]})})).rejects.toMatchObject({status:400,response:expect.objectContaining({statusCode:400,message:'每项组成必须是有效对象'})});
  expect(await resources.get(f.user,'finance-bundles',f.bundle.id)).toEqual(before);expect(await f.lines()).toEqual(lines);expect(await ds.manager.count(ResourceRecord,{where:{companyId:f.user.companyId,type:'finance-bundle-revisions'}})).toBe(0);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:f.user.companyId}})).toBe(logs);
 });

});
