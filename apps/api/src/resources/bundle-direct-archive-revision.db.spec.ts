import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceChangeLog, ResourceLink, ResourceRecord, User } from '../entities';
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
  return{user,category,first,second,base,bundle,lines,payload};
 };
 it('直接档案修订发布保留productId与控制列、六位元报价精度、同一验证事务和BOM版本',async()=>{
  const f=await fixture();const revision=await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'真实档案替换并修订数量',payload:JSON.stringify((await f.payload()).map(line=>line.productId?{...line,role:'main',cost:999999,unitCost:999999}:line))});
  expect(JSON.parse(String(revision.data.payload)).find((line:{productId?:number})=>line.productId)).not.toHaveProperty('cost');
  expect((await f.lines()).find(line=>line.data.productId)?.data.productId).toBe(f.first.id);
  await resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified');
  const lines=await f.lines(),direct=lines.find(line=>line.data.productId)!;
  expect(direct.data).toMatchObject({productId:f.second.id,role:'main',qty:2.345,lossRate:1.2345,isRequired:false,includeInJst:false,costTreatment:'reference_only'});expect(direct.data.baseCodeId).toBeUndefined();
  expect((await resources.get(f.user,'finance-bundle-revisions',revision.id)).status).toBe('published');
  const fresh=await resources.get(f.user,'finance-bundles',f.bundle.id);expect(fresh).toMatchObject({status:'verified',data:{bomVersion:'V02'}});expect(fresh.data.pendingRevisionId).toBeUndefined();
  const cost=new CostService(ds),data=await cost.load(f.user.companyId),row=cost.row(data,data.bundles.find(bundle=>bundle.id===f.bundle.id)!);
  expect(row.preShipCostCents).toBe(1028.9289);expect(row.weightG).toBe(3895.059615);
  const product=await resources.get(f.user,'finance-products',f.second.id);
  expect(JSON.parse(String(fresh.data.snapshot)).lines.find((line:{ref:string})=>line.ref===product.data.code)).toMatchObject({qty:2.345,cost:212.5681,weightG:1234.567});
 });
 it('不同档案ID参与来源token，价格同为真实事实也不能被迟到修订混同',async()=>{
  const f=await fixture();await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'等待验证的修订',payload:JSON.stringify(await f.payload())});
  const line=(await f.lines()).find(line=>line.data.productId)!;
  await ds.manager.update(ResourceRecord,{id:line.id,companyId:f.user.companyId},{data:{...line.data,productId:f.second.id}});
  await expect(resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified')).rejects.toThrow(/构成又被改过/);
  expect((await f.lines()).find(line=>line.data.productId)?.data.productId).toBe(f.second.id);
 });
 it('普通请求/runner伪造发布标记不能新建直接档案；跨公司、停用及非末级来源拒绝',async()=>{
  const f=await fixture(),foreign=await fixture();
  await expect(resources.create(f.user,'finance-bundle-lines',{bundleId:f.bundle.id,productId:f.first.id,role:'package',qty:1,unit:'KG',publishing:true})).rejects.toThrow(/只能由历史BOM导入/);
  await expect(ds.transaction(async em=>{em.queryRunner!.data.publishing=true;await resources.createRecord(em,f.user,'finance-bundle-lines',{bundleId:f.bundle.id,productId:f.first.id,role:'package',qty:1,unit:'KG'});})).rejects.toThrow(/只能由历史BOM导入/);
  await expect(resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'跨公司档案不可用',payload:JSON.stringify(await f.payload(foreign.second.id))})).rejects.toThrow(/不存在/);
  await resources.changeStatus(f.user,'finance-products',f.second.id,'inactive','合成停用');
  await expect(resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'停用档案不可用',payload:JSON.stringify(await f.payload())})).rejects.toThrow(/停用/);
  await ds.manager.update(ResourceRecord,{id:f.second.id,companyId:f.user.companyId},{status:'active'});
  await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:f.user.companyId,type:'finance-categories',title:'合成非法下级',status:'active',data:{archiveType:'raw',name:'合成非法下级',code:'CHILD',parentId:f.category.id},searchText:'',createdBy:f.user.id,updatedBy:f.user.id}));
  await expect(resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'非末级档案不可用',payload:JSON.stringify(await f.payload())})).rejects.toThrow(/末级/);
 });
 it('发布中途失败整组回滚旧行/引用/修订/审计，移除内部作用域后可重试',async()=>{
  const f=await fixture();const revision=await resources.create(f.user,'finance-bundle-revisions',{bundleId:f.bundle.id,reason:'模拟发布失败回滚',payload:JSON.stringify(await f.payload())});
  const before=await f.lines(),record=await resources.get(f.user,'finance-bundles',f.bundle.id),links=await ds.manager.find(ResourceLink,{where:{companyId:f.user.companyId},order:{id:'ASC'}}),logs=await ds.manager.count(ResourceChangeLog,{where:{companyId:f.user.companyId}});
  const original=resources.createRecord.bind(resources);let inserted=0;
  const spy=jest.spyOn(resources,'createRecord').mockImplementation(async(em,user,type,values,note,status)=>{if(type==='finance-bundle-lines' && note==='发布构成修订' && ++inserted===2)throw new Error('合成第二行发布失败');return original(em,user,type,values,note,status);});
  try{await expect(resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified')).rejects.toThrow('合成第二行发布失败');}finally{spy.mockRestore();}
  expect(inserted).toBe(2);expect(await f.lines()).toEqual(before);expect(await resources.get(f.user,'finance-bundles',f.bundle.id)).toEqual(record);
  expect(await ds.manager.find(ResourceLink,{where:{companyId:f.user.companyId},order:{id:'ASC'}})).toEqual(links);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:f.user.companyId}})).toBe(logs);expect((await resources.get(f.user,'finance-bundle-revisions',revision.id)).status).toBe('pending');
  await resources.changeStatus(f.user,'finance-bundles',f.bundle.id,'verified');expect((await resources.get(f.user,'finance-bundle-revisions',revision.id)).status).toBe('published');
 });
});
