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
   const code='A+1-B*2'+'A'.repeat(size-7),p=await raw(`合成边界${size}`,code),bc=await base(p.id);
   expect(p.data.code).toBe(code);
   if(size===48){expect(bc.data.code).toBe(code);expect(bc.data.styleCode).toBe(code);}
   else {expect(bc.data.code).not.toBe(code);expect(String(bc.data.code).length).toBeLessThanOrEqual(48);}
   expect(bc.data.codeChangeReason).toBeUndefined();expect(bc.data.profileManual).not.toBe(true);
  }
  const p=await raw('合成变更','SYNC+ORIGINAL*1');
  const changed=await svc.update(boss,'finance-products',p.id,{name:'合成变更后',code:'SYNC+CHANGED*2'});
  const bc=await base(p.id);
  expect(bc.data).toMatchObject({code:'SYNC+CHANGED*2',styleCode:'SYNC+CHANGED*2',name:changed.data.basicInfoFullName});
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
 it('自动资料随商品改名、规格和分类更新；手工专属资料保持独立，成本仍联动',async()=>{
  const p=await raw('同步前','SYNC-PROFILE-BEFORE'),bc=await base(p.id),nextCategory=await svc.create(boss,'finance-categories',{archiveType:'raw',name:'新合成分类',code:'NEXTSYNC'});
  await svc.changeStatus(boss,'finance-base-codes',bc.id,'verified');
  await svc.update(boss,'finance-products',p.id,{name:'同步后',code:'SYNC-PROFILE-AFTER',specQty:250,specUnit:'G',purchaseSpec:'250克',categoryId:nextCategory.id});
  const updated=await base(p.id);expect(updated.id).toBe(bc.id);expect(updated.status).toBe('reverify');expect(updated.data).toMatchObject({varietyName:'同步后',spec:'250G',categoryId:nextCategory.id,code:'SYNC-PROFILE-AFTER'});expect(updated.data.profileManual).not.toBe(true);
  await svc.update(boss,'finance-base-codes',bc.id,{varietyName:'人工品种',spec:'专属规格',name:'人工名称'});
  await svc.update(boss,'finance-products',p.id,{name:'再次改名',specQty:500,specUnit:'G',code:'SYNC-PROFILE-THIRD',purchasePrice:222});
  expect((await base(p.id)).data).toMatchObject({varietyName:'人工品种',spec:'专属规格',name:'人工名称',code:'SYNC-PROFILE-AFTER',profileManual:true,cost:224});
 });
 it('客户端伪造origin或事务标志不能取得精确原号同步特权',async()=>{
  const p=await raw('合成防伪','SYNC-TRUSTED'),bc=await base(p.id);
  await expect(svc.update(boss,'finance-base-codes',bc.id,{code:'FORGED-CODE',origin:'archive_sync'})).rejects.toThrow(/原因/);
  await expect(svc.update(boss,'finance-base-codes',bc.id,{code:'FORGED-CODE',origin:'archive_sync',baseCodeSync:true})).rejects.toThrow();
  expect((await base(p.id)).data.code).toBe('SYNC-TRUSTED');
 });
 it('仅上传后锁编码：验证/排队/失败可改码，上传后款式等资料可改，停用不解除上传历史',async()=>{
  const p=await raw('合成上传边界','UPLOAD-BOUNDARY'),bc=await base(p.id);
  await svc.changeStatus(boss,'finance-base-codes',bc.id,'verified');
  await ds.transaction(em=>svc.patchData(em,boss,'finance-base-codes',bc.id,{jstStatus:'pending',_financeCodeFrozen:true}));
  await svc.update(boss,'finance-base-codes',bc.id,{code:'BEFORE-UPLOAD',codeChangeReason:'尚未上传允许修改'});
  await ds.transaction(em=>svc.patchData(em,boss,'finance-base-codes',bc.id,{jstStatus:'failed'}));
  await svc.update(boss,'finance-base-codes',bc.id,{code:'AFTER-FAILED',codeChangeReason:'首次未成功上传'});
  await ds.transaction(em=>svc.patchData(em,boss,'finance-base-codes',bc.id,{jstStatus:'synced',jstUploadedCode:'AFTER-FAILED'}));
  expect((await base(p.id)).data._financeCodeUploaded).toBe(true);
  await expect(svc.update(boss,'finance-base-codes',bc.id,{code:'WRONG',codeChangeReason:'有原因也不能改已上传编码'})).rejects.toThrow(/固定/);
  const uploaded=await base(p.id);
  await expect(svc.saveForm(boss,'finance-base-codes',{requestKey:randomUUID(),id:bc.id,version:uploaded.version,values:{code:''},collections:[]})).rejects.toThrow(/固定/);
  await svc.update(boss,'finance-base-codes',bc.id,{name:'上传后新名称',styleCode:'EDITABLE-STYLE',spec:'自由规格',varietyName:'可维护品种',codeChangeReason:'维护其他资料'});
  expect((await base(p.id)).data).toMatchObject({code:'AFTER-FAILED',name:'上传后新名称',styleCode:'EDITABLE-STYLE',spec:'自由规格',varietyName:'可维护品种'});
  await ds.transaction(em=>svc.patchData(em,boss,'finance-base-codes',bc.id,{jstUploadedCode:null,jstStatus:'not_synced'}));
  expect((await base(p.id)).data._financeCodeUploaded).toBe(true);
  await expect(ds.transaction(em=>svc.patchData(em,boss,'finance-base-codes',bc.id,{code:'INTERNAL-WRONG'}))).rejects.toThrow(/固定/);
  await expect(svc.update(boss,'finance-base-codes',bc.id,{_financeCodeUploaded:false})).rejects.toThrow(/锁定标识/);
 });
 it('同公司编码冲突使整组保存回滚，主档/来源/基础编码均不改变',async()=>{
  const owner=await raw('合成占用','SYNC-OWNER'),owned=await base(owner.id);
  await svc.update(boss,'finance-base-codes',owned.id,{code:'SYNC+CONFLICT*2',codeChangeReason:'合成手改'});
  const p=await raw('合成回滚','SYNC-ROLLBACK');
  const before=await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}});
  const graph=(rows:ResourceRecord[])=>rows.map(r=>[r.id,r.type,r.data,r.status]);
  await expect(svc.saveForm(boss,'finance-products',{requestKey:randomUUID(),id:p.id,version:p.version,values:{name:'不应保存',code:'SYNC+CONFLICT*2'},collections:[{type:'finance-product-sources',expected:[],rows:[{values:{supplierId,originArea:'不应新增',purchasePrice:222}}]}]})).rejects.toThrow(/存在|编码/);
  expect(graph(await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}}))).toEqual(graph(before));
  await expect(svc.saveForm(boss,'finance-products',{requestKey:randomUUID(),values:{archiveType:'raw',categoryId,name:'不应创建',code:'SYNC+CONFLICT*2',specQty:1,specUnit:'KG',purchaseSpec:'千克',freight:1,handlingFee:1},collections:[{type:'finance-product-sources',expected:[],rows:[{values:{supplierId,originArea:'不应新增',purchasePrice:222}}]}]})).rejects.toThrow(/存在|编码/);
  expect(graph(await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}}))).toEqual(graph(before));
 });
 it('真实聚水潭镜像也视为已上传，前端读口与内部写口一致且不跨公司',async()=>{
  const p=await raw('镜像已存在','MIRROR-LOCK'),bc=await base(p.id);
  await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:boss.companyId,type:'finance-jst-skus',uniqueKey:'mirror-lock',title:'镜像已上传',status:'active',data:{skuId:'MIRROR-LOCK',goodsType:'normal'}}));
  expect((await base(p.id)).data._financeCodeUploaded).toBe(true);
  await svc.update(boss,'finance-products',p.id,{code:'SOURCE-CODE-EDITED',name:'来源仍可维护'});
  expect((await base(p.id)).data.code).toBe('MIRROR-LOCK');
  await expect(svc.update(boss,'finance-base-codes',bc.id,{code:'MIRROR-NEW',codeChangeReason:'镜像已有不能改码'})).rejects.toThrow(/固定/);
  await expect(ds.transaction(em=>svc.patchData(em,boss,'finance-base-codes',bc.id,{code:'MIRROR-INTERNAL'}))).rejects.toThrow(/固定/);
  await svc.update(boss,'finance-base-codes',bc.id,{styleCode:'MIRROR-STYLE',name:'镜像资料仍可改',codeChangeReason:'其他资料维护'});
  expect((await base(p.id)).data).toMatchObject({code:'MIRROR-LOCK',styleCode:'MIRROR-STYLE',name:'镜像资料仍可改'});
  const free=await raw('外公司镜像不锁本公司','FOREIGN-MIRROR'),freeBase=await base(free.id);
  await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:other.companyId,type:'finance-jst-skus',uniqueKey:'foreign-mirror',title:'另一公司镜像',status:'active',data:{skuId:'FOREIGN-MIRROR',goodsType:'normal'}}));
  await svc.update(boss,'finance-base-codes',freeBase.id,{code:'NOT-LOCKED',codeChangeReason:'本公司未上传'});
  expect((await base(free.id)).data.code).toBe('NOT-LOCKED');
 });
 it('上传回写基于当前行，保留旧事务快照之后已提交的名称款式和重验状态',async()=>{
  const p=await raw('并发上传回写','CONCURRENT-UPLOAD'),bc=await base(p.id);await svc.changeStatus(boss,'finance-base-codes',bc.id,'verified');
  const tx=ds.createQueryRunner();await tx.connect();await tx.startTransaction('REPEATABLE READ');
  try{
   const original=await tx.manager.findOneByOrFail(ResourceRecord,{id:bc.id,companyId:boss.companyId});
   await svc.update(boss,'finance-base-codes',bc.id,{name:'并发维护的新名称',styleCode:'CONCURRENT-STYLE',codeChangeReason:'其他资料可改'});
   expect((await tx.manager.findOneByOrFail(ResourceRecord,{id:bc.id,companyId:boss.companyId})).data.name).toBe(original.data.name);
   await svc.patchData(tx.manager,boss,'finance-base-codes',bc.id,{jstStatus:'synced',jstUploadedCode:String(bc.data.code)},'合成上传成功');
   await tx.commitTransaction();
   const result=await base(p.id);expect(result.data).toMatchObject({code:bc.data.code,name:'并发维护的新名称',styleCode:'CONCURRENT-STYLE',_financeCodeUploaded:true});expect(result.status).toBe('reverify');
  }catch(error){if(tx.isTransactionActive)await tx.rollbackTransaction();throw error;}finally{await tx.release();}
 });
 it('不同公司可有同一原号，跨公司来源ID不能用于基础编码创建',async()=>{
  const a=await raw('合成本公司','SYNC-COMPANY'),b=await raw('合成另一公司','SYNC-COMPANY',other);
  expect((await base(a.id)).data.code).toBe('SYNC-COMPANY');expect((await base(b.id,other)).data.code).toBe('SYNC-COMPANY');
  await expect(svc.create(boss,'finance-base-codes',{productId:b.id,origin:'archive_sync'})).rejects.toThrow();
  await svc.update(other,'finance-products',b.id,{code:'SYNC-OTHER-NEW'});
  expect((await base(a.id)).data.code).toBe('SYNC-COMPANY');expect((await base(b.id,other)).data.code).toBe('SYNC-OTHER-NEW');
 });
});
