import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('商品档案原编号同步（隔离数据库）',()=>{
 let ds:DataSource,svc:ResourcesService,boss:AuthUser,other:AuthUser,categoryId:number,otherCategoryId:number,supplierId:number;
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true} as never).initialize();
  svc=buildServices(ds).resources;
  const actor=async()=>{
   const company=await ds.manager.save(Company,ds.manager.create(Company,{code:`sync${randomBytes(5).toString('hex')}`,name:'合成编号同步',status:'active'}));
   const user=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'admin',passwordHash:'x',name:'合成管理员',isCompanyAdmin:true,status:'active',mustChangePassword:false}));
   return {id:user.id,companyId:company.id,name:user.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
  };
  boss=await actor();other=await actor();
  categoryId=(await svc.create(boss,'finance-categories',{archiveType:'raw',name:'合成分类',code:'SYNC'})).id;
  otherCategoryId=(await svc.create(other,'finance-categories',{archiveType:'raw',name:'合成分类',code:'SYNC'})).id;
  supplierId=(await svc.create(boss,'finance-suppliers',{name:'合成供应商'})).id;
 });
 afterAll(async()=>{await ds?.destroy();});
 const raw=(name:string,code:string,user=boss)=>svc.create(user,'finance-products',{archiveType:'raw',categoryId:user.companyId===boss.companyId?categoryId:otherCategoryId,name,code,specQty:1,specUnit:'KG',purchaseSpec:'千克',weightG:100,purchasePrice:100,freight:1,handlingFee:1});
 const base=async(productId:number,user=boss)=>(await svc.list(user,'finance-base-codes',{fieldKey:'productId',fieldValue:String(productId),showHidden:true,pageSize:200})).items[0];
 it('48位原号精确创建并固定，49/160位保持既有独立生成兼容，不伪造手改原因',async()=>{
  for(const size of [48,49,160]){
   const code='A+1-B*2'+'A'.repeat(size-7),p=await raw(`合成边界${size}`,code),bc=await base(p.id);
   expect(p.data.code).toBe(code);
   if(size===48){expect(bc.data.code).toBe(code);expect(bc.data.styleCode).toBe(code);}
   else {expect(bc.data.code).not.toBe(code);expect(String(bc.data.code).length).toBeLessThanOrEqual(48);}
   expect(bc.data.codeChangeReason).toBeUndefined();expect(bc.data.profileManual).not.toBe(true);
  }
  const p=await raw('合成变更','SYNC+ORIGINAL*1');
  await expect(svc.update(boss,'finance-products',p.id,{code:'SYNC+CHANGED*2'})).rejects.toThrow(/固定/);
  const changed=await svc.update(boss,'finance-products',p.id,{name:'合成变更后'});
  const bc=await base(p.id);
  expect(bc.data).toMatchObject({code:'SYNC+ORIGINAL*1',styleCode:'SYNC+ORIGINAL*1',name:changed.data.basicInfoFullName});
  expect(bc.data.profileManual).not.toBe(true);
  await svc.changeStatus(boss,'finance-base-codes',bc.id,'verified');
  await svc.update(boss,'finance-products',p.id,{purchasePrice:111});
  const reverified=await base(p.id);
  expect(reverified.status).toBe('reverify');
  expect(reverified.data).toMatchObject({code:'SYNC+ORIGINAL*1',styleCode:'SYNC+ORIGINAL*1'});
 });
 it('人工覆盖和停用/已删除编码不被源档案重编号或重新生成',async()=>{
  const p=await raw('合成人工','SYNC-MANUAL'),bc=await base(p.id);
  await svc.update(boss,'finance-base-codes',bc.id,{name:'合成独立名称'});
  await svc.update(boss,'finance-products',p.id,{name:'合成人工来源更新'});
  expect((await base(p.id)).data).toMatchObject({code:'SYNC-MANUAL',styleCode:'SYNC-MANUAL',name:'合成独立名称',profileManual:true});
  for(const status of ['disabled','deleted']){
   const source=await raw(`合成${status}`,`SYNC-${status.toUpperCase()}`),linked=await base(source.id);
   await svc.changeStatus(boss,'finance-base-codes',linked.id,status,'合成停用');
   await svc.update(boss,'finance-products',source.id,{name:`合成${status}更新`});
   const rows=(await svc.list(boss,'finance-base-codes',{fieldKey:'productId',fieldValue:String(source.id),showHidden:true,pageSize:200})).items;
   expect(rows).toHaveLength(1);expect(rows[0].id).toBe(linked.id);expect(rows[0].status).toBe(status);expect(rows[0].data.code).toBe(linked.data.code);
  }
 });
 it('自动资料随商品改名、规格和分类更新；手工专属资料保持独立，成本仍联动',async()=>{
  const p=await raw('同步前','SYNC-PROFILE-BEFORE'),bc=await base(p.id),nextCategory=await svc.create(boss,'finance-categories',{archiveType:'raw',name:'新合成分类',code:'NEXTSYNC'});
  await svc.changeStatus(boss,'finance-base-codes',bc.id,'verified');
  await svc.update(boss,'finance-products',p.id,{name:'同步后',specQty:250,specUnit:'G',purchaseSpec:'250克',categoryId:nextCategory.id});
  const updated=await base(p.id);expect(updated.id).toBe(bc.id);expect(updated.status).toBe('reverify');expect(updated.data).toMatchObject({varietyName:'同步后',spec:'250G',categoryId:nextCategory.id,code:'SYNC-PROFILE-BEFORE'});expect(updated.data.profileManual).not.toBe(true);
  await svc.update(boss,'finance-base-codes',bc.id,{varietyName:'人工品种',spec:'专属规格',name:'人工名称'});
  await svc.update(boss,'finance-products',p.id,{name:'再次改名',specQty:500,specUnit:'G',purchasePrice:222});
  expect((await base(p.id)).data).toMatchObject({varietyName:'人工品种',spec:'专属规格',name:'人工名称',code:'SYNC-PROFILE-BEFORE',profileManual:true,cost:224});
 });
 it('客户端伪造origin或事务标志不能取得精确原号同步特权',async()=>{
  const p=await raw('合成防伪','SYNC-TRUSTED'),bc=await base(p.id);
  await expect(svc.update(boss,'finance-base-codes',bc.id,{code:'FORGED-CODE',origin:'archive_sync'})).rejects.toThrow(/固定/);
  await expect(svc.update(boss,'finance-base-codes',bc.id,{code:'FORGED-CODE',origin:'archive_sync',baseCodeSync:true})).rejects.toThrow();
  expect((await base(p.id)).data.code).toBe('SYNC-TRUSTED');
 });
 it('普通更新、表单事务及内部联动都不能改/清空已保存编号',async()=>{
  const p=await raw('固定身份','IMMUTABLE-ARCHIVE'),bc=await base(p.id);
  for(const [type,id]of [['finance-products',p.id],['finance-base-codes',bc.id]] as const){
   for(const code of ['', 'WRONG-IDENTITY'])await expect(svc.update(boss,type,id,{code,...(type==='finance-base-codes'?{codeChangeReason:'改码原因不能解锁身份'}:{})})).rejects.toThrow();
   await expect(ds.transaction(em=>svc.patchData(em,boss,type,id,{code:'INTERNAL-RECODE'},'合成内部重编'))).rejects.toThrow(/固定/);
  }
  await expect(svc.update(boss,'finance-base-codes',bc.id,{styleCode:'WRONG-STYLE',codeChangeReason:'有原因仍不可改'})).rejects.toThrow(/固定/);
  await expect(svc.saveForm(boss,'finance-products',{requestKey:randomUUID(),id:p.id,version:p.version,values:{name:'不应修改',code:''},collections:[]})).rejects.toThrow(/固定/);
  expect((await svc.get(boss,'finance-products',p.id)).data).toMatchObject({name:'固定身份',code:'IMMUTABLE-ARCHIVE'});expect((await base(p.id)).data).toMatchObject({code:'IMMUTABLE-ARCHIVE',styleCode:'IMMUTABLE-ARCHIVE'});
 });
 it('同公司编码冲突使整组保存回滚，主档/来源/基础编码均不改变',async()=>{
  await raw('合成占用','SYNC+CONFLICT*2');
  const p=await raw('合成回滚','SYNC-ROLLBACK');
  const before=await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}});
  const graph=(rows:ResourceRecord[])=>rows.map(r=>[r.id,r.type,r.data,r.status]);
  await expect(svc.saveForm(boss,'finance-products',{requestKey:randomUUID(),id:p.id,version:p.version,values:{name:'不应保存',code:'SYNC+CONFLICT*2'},collections:[{type:'finance-product-sources',expected:[],rows:[{values:{supplierId,originArea:'不应新增',purchasePrice:222}}]}]})).rejects.toThrow(/存在|编码|固定/);
  expect(graph(await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}}))).toEqual(graph(before));
  await expect(svc.saveForm(boss,'finance-products',{requestKey:randomUUID(),values:{archiveType:'raw',categoryId,name:'不应创建',code:'SYNC+CONFLICT*2',specQty:1,specUnit:'KG',purchaseSpec:'千克',freight:1,handlingFee:1},collections:[{type:'finance-product-sources',expected:[],rows:[{values:{supplierId,originArea:'不应新增',purchasePrice:222}}]}]})).rejects.toThrow(/存在|编码|固定/);
  expect(graph(await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}}))).toEqual(graph(before));
 });
 it('不同公司可有同一原号，跨公司来源ID不能用于基础编码创建',async()=>{
  const a=await raw('合成本公司','SYNC-COMPANY'),b=await raw('合成另一公司','SYNC-COMPANY',other);
  expect((await base(a.id)).data.code).toBe('SYNC-COMPANY');expect((await base(b.id,other)).data.code).toBe('SYNC-COMPANY');
  await expect(svc.create(boss,'finance-base-codes',{productId:b.id,origin:'archive_sync'})).rejects.toThrow();
  await svc.update(other,'finance-products',b.id,{name:'合成另一公司更新'});
  expect((await base(a.id)).data.code).toBe('SYNC-COMPANY');expect((await base(b.id,other)).data.code).toBe('SYNC-COMPANY');
 });
});
