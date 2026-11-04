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
 it('48位原号精确创建并更新，49/160位保持既有独立生成兼容，不伪造手改原因',async()=>{
  for(const size of [48,49,160]){
   const code='A'.repeat(size),p=await raw(`合成边界${size}`,code),bc=await base(p.id);
   expect(p.data.code).toBe(code);
   if(size===48){expect(bc.data.code).toBe(code);expect(bc.data.styleCode).toBe(code);}
   else {expect(bc.data.code).not.toBe(code);expect(String(bc.data.code).length).toBeLessThanOrEqual(48);}
   expect(bc.data.codeChangeReason).toBeUndefined();expect(bc.data.profileManual).not.toBe(true);
  }
  const p=await raw('合成变更','SYNC-ORIGINAL');
  const changed=await svc.update(boss,'finance-products',p.id,{name:'合成变更后',code:'SYNC-CHANGED'});
  const bc=await base(p.id);
  expect(bc.data).toMatchObject({code:'SYNC-CHANGED',styleCode:'SYNC-CHANGED',name:changed.data.basicInfoFullName});
  expect(bc.data.profileManual).not.toBe(true);
  await svc.changeStatus(boss,'finance-base-codes',bc.id,'verified');
  await svc.update(boss,'finance-products',p.id,{code:'SYNC-VERIFIED-CHANGED'});
  const reverified=await base(p.id);
  expect(reverified.status).toBe('reverify');
  expect(reverified.data).toMatchObject({code:'SYNC-VERIFIED-CHANGED',styleCode:'SYNC-VERIFIED-CHANGED'});
 });
 it('人工覆盖和停用/已删除编码不被源档案重编号或重新生成',async()=>{
  const p=await raw('合成人工','SYNC-MANUAL'),bc=await base(p.id);
  await svc.update(boss,'finance-base-codes',bc.id,{name:'合成独立名称'});
  await svc.update(boss,'finance-products',p.id,{code:'SYNC-MANUAL-NEW'});
  expect((await base(p.id)).data).toMatchObject({code:'SYNC-MANUAL',styleCode:'SYNC-MANUAL',name:'合成独立名称',profileManual:true});
  for(const status of ['disabled','deleted']){
   const source=await raw(`合成${status}`,`SYNC-${status.toUpperCase()}`),linked=await base(source.id);
   await svc.changeStatus(boss,'finance-base-codes',linked.id,status,'合成停用');
   await svc.update(boss,'finance-products',source.id,{code:`SYNC-${status.toUpperCase()}-NEW`});
   const rows=(await svc.list(boss,'finance-base-codes',{fieldKey:'productId',fieldValue:String(source.id),showHidden:true,pageSize:200})).items;
   expect(rows).toHaveLength(1);expect(rows[0].id).toBe(linked.id);expect(rows[0].status).toBe(status);expect(rows[0].data.code).toBe(linked.data.code);
  }
 });
 it('客户端伪造origin或事务标志不能取得精确原号同步特权',async()=>{
  const p=await raw('合成防伪','SYNC-TRUSTED'),bc=await base(p.id);
  await expect(svc.update(boss,'finance-base-codes',bc.id,{code:'FORGED-CODE',origin:'archive_sync'})).rejects.toThrow(/原因/);
  await expect(svc.update(boss,'finance-base-codes',bc.id,{code:'FORGED-CODE',origin:'archive_sync',baseCodeSync:true})).rejects.toThrow();
  expect((await base(p.id)).data.code).toBe('SYNC-TRUSTED');
 });
 it('同公司编码冲突使整组保存回滚，主档/来源/基础编码均不改变',async()=>{
  const owner=await raw('合成占用','SYNC-OWNER'),owned=await base(owner.id);
  await svc.update(boss,'finance-base-codes',owned.id,{code:'SYNC-CONFLICT',codeChangeReason:'合成手改'});
  const p=await raw('合成回滚','SYNC-ROLLBACK');
  const before=await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}});
  const graph=(rows:ResourceRecord[])=>rows.map(r=>[r.id,r.type,r.data,r.status]);
  await expect(svc.saveForm(boss,'finance-products',{requestKey:randomUUID(),id:p.id,version:p.version,values:{name:'不应保存',code:'SYNC-CONFLICT'},collections:[{type:'finance-product-sources',expected:[],rows:[{values:{supplierId,originArea:'不应新增',purchasePrice:222}}]}]})).rejects.toThrow(/存在|编码/);
  expect(graph(await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}}))).toEqual(graph(before));
  await expect(svc.saveForm(boss,'finance-products',{requestKey:randomUUID(),values:{archiveType:'raw',categoryId,name:'不应创建',code:'SYNC-CONFLICT',specQty:1,specUnit:'KG',purchaseSpec:'千克',freight:1,handlingFee:1},collections:[{type:'finance-product-sources',expected:[],rows:[{values:{supplierId,originArea:'不应新增',purchasePrice:222}}]}]})).rejects.toThrow(/存在|编码/);
  expect(graph(await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}}))).toEqual(graph(before));
 });
 it('不同公司可有同一原号，跨公司来源ID不能用于基础编码创建',async()=>{
  const a=await raw('合成本公司','SYNC-COMPANY'),b=await raw('合成另一公司','SYNC-COMPANY',other);
  expect((await base(a.id)).data.code).toBe('SYNC-COMPANY');expect((await base(b.id,other)).data.code).toBe('SYNC-COMPANY');
  await expect(svc.create(boss,'finance-base-codes',{productId:b.id,origin:'archive_sync'})).rejects.toThrow();
  await svc.update(other,'finance-products',b.id,{code:'SYNC-OTHER-NEW'});
  expect((await base(a.id)).data.code).toBe('SYNC-COMPANY');expect((await base(b.id,other)).data.code).toBe('SYNC-OTHER-NEW');
 });
});
