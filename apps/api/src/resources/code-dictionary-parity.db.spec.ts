import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceLink, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { BaseCodeToolsService } from './base-code-tools.service';
import { OutboxService } from '../outbox/outbox.service';
import { ResourcesService } from './resources.service';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('编码独立分类维护统一规则（隔离数据库）',()=>{
 let ds:DataSource,svc:ResourcesService,actor:AuthUser,other:AuthUser;
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();svc=buildServices(ds).resources;
  const user=async()=>{const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'合成编码目录',status:'active'}));const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'code-dir',passwordHash:'x',name:'合成管理员',isCompanyAdmin:true,status:'active',mustChangePassword:false}));return{id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};actor=await user();other=await user();
 });
 afterAll(async()=>{await ds?.destroy();});
 const create=(name:string,extra:Record<string,unknown>={},user=actor)=>svc.create(user,'finance-code-dictionaries',{kind:'product_category',name,...extra});
 it('普通维护空码按名称生成并避让，同kind唯一，品种与分类域分离',async()=>{
  const a=await create('A-B'),b=await create('A B');expect(a.data.code).toBe('AB');expect(b.data.code).toBe('AB2');
  await expect(create('其他',{code:'AB'})).rejects.toThrow(/已有|存在/);
  const variety=await create('合成品种',{kind:'variety',code:'AB'});expect(variety.data.code).toBe('AB');
  await expect(create('品种子级',{kind:'variety',parentId:variety.id})).rejects.toThrow(/品种/);
 });
 it('真实四级可保存，第五级/移动超深/循环/跨公司/跨kind/停用上级拒绝',async()=>{
  const root=await create('合成根',{code:'ROOT'}),child=await create('合成二级',{code:'CHILD',parentId:root.id});
  const third=await create('合成三级',{parentId:child.id}),fourth=await create('合成四级',{parentId:third.id});
  expect(fourth.data.parentId).toBe(third.id);
  await expect(create('合成五级',{parentId:fourth.id})).rejects.toThrow(/四级/);
  const otherRoot=await create('另一根');
  await expect(svc.update(actor,'finance-code-dictionaries',root.id,{parentId:otherRoot.id})).rejects.toThrow(/四级/);
  await expect(svc.update(actor,'finance-code-dictionaries',root.id,{parentId:child.id})).rejects.toThrow(/循环/);
  await expect(svc.update(actor,'finance-code-dictionaries',root.id,{parentId:root.id})).rejects.toThrow(/循环/);
  const foreign=await create('其他公司根',{},other),variety=await create('品种根',{kind:'variety'}),inactive=await create('停用根');
  await svc.changeStatus(actor,'finance-code-dictionaries',inactive.id,'inactive');
  for(const parentId of [foreign.id,variety.id,inactive.id])await expect(create('非法归属'+parentId,{parentId})).rejects.toThrow(/同类|启用/);
  expect((await svc.get(actor,'finance-code-dictionaries',root.id)).data.parentId).toBeUndefined();
 });
 it('两套编码分类共享规范化名称，跨层/跨套拒绝，档案与品种及公司仍独立，旧重名不迁移',async()=>{
  const root=await create('名称域根'),child=await create('  Ｘ Ｙ 名称域  ',{parentId:root.id});
  await expect(create('xy名称域')).rejects.toThrow(/名称已存在/);
  await expect(svc.create(actor,'finance-categories',{archiveType:'bundle',name:'X Y 名称域',code:'NAB'})).rejects.toThrow(/名称已存在/);
  const bundle=await svc.create(actor,'finance-categories',{archiveType:'bundle',name:'组合独占名称',code:'NBUN'});
  await expect(create('组合独占名称')).rejects.toThrow(/名称已存在/);
  await svc.create(actor,'finance-categories',{archiveType:'raw',name:'xy名称域',code:'NRAW'});
  await create('xy名称域',{kind:'variety'});await create('xy名称域',{},other);
  const legacy=await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:actor.companyId,type:'finance-code-dictionaries',title:'旧重复',data:{kind:'product_category',name:child.data.name,code:'LEGACY-DUP'},status:'active',createdBy:actor.id,updatedBy:actor.id}));
  expect((await svc.update(actor,'finance-code-dictionaries',legacy.id,{sort:90})).data.name).toBe(child.data.name);
  await expect(svc.update(actor,'finance-code-dictionaries',legacy.id,{name:bundle.data.name})).rejects.toThrow(/名称已存在/);
 });
 it('真实并发跨两套目录创建同名，等待公司锁后也只能一条成功',async()=>{
  const result=await Promise.allSettled([create('并发唯一分类'),svc.create(actor,'finance-categories',{archiveType:'bundle',name:'并 发 唯 一 分 类',code:'CONCUR'})]);
  expect(result.filter(row=>row.status==='fulfilled')).toHaveLength(1);
  const failed=result.find(row=>row.status==='rejected') as PromiseRejectedResult;expect(String(failed.reason)).toMatch(/名称已存在/);
 });
 it('grid改名先等待公司锁且不先占分类行，与另一套普通新增同名只能一条成功',async()=>{
  const original=await create('并发改名前分类'),runner=ds.createQueryRunner();await runner.connect();await runner.startTransaction();
  await runner.manager.findOneOrFail(Company,{where:{id:actor.companyId},lock:{mode:'pessimistic_write'}});
  const editing=svc.saveGridRow(actor,'finance-code-dictionaries',{id:original.id,version:original.version,values:{name:'并发改名目标'}},'合成并发改名');
  let settled=false;void editing.then(()=>{settled=true;},()=>{settled=true;});
  try{await new Promise(resolve=>setTimeout(resolve,40));expect(settled).toBe(false);await runner.manager.findOneOrFail(ResourceRecord,{where:{id:original.id,companyId:actor.companyId},lock:{mode:'pessimistic_write',onLocked:'nowait'}});await runner.commitTransaction();}finally{if(runner.isTransactionActive)await runner.rollbackTransaction();await runner.release();}
  const result=await Promise.allSettled([editing,svc.create(actor,'finance-categories',{archiveType:'bundle',name:'并 发 改 名 目 标',code:'GRIDNEW'})]);
  expect(result.filter(row=>row.status==='fulfilled')).toHaveLength(1);const failed=result.find(row=>row.status==='rejected') as PromiseRejectedResult;expect(String(failed.reason)).toMatch(/名称已存在/);
 });
 it('统一排序必须同kind同级完整；跨域/漏项/其他公司拒绝',async()=>{
  const all=(await svc.list(actor,'finance-code-dictionaries',{showHidden:true,pageSize:200})).items;
  const roots=all.filter(r=>r.status==='active'&&r.data.kind==='product_category'&&!r.data.parentId),variety=all.find(r=>r.data.kind==='variety')!;
  const ids=roots.map(r=>r.id).reverse();await svc.reorderCategories(actor,'finance-code-dictionaries',ids);
  const sorted=await ds.manager.find(ResourceRecord,{where:{companyId:actor.companyId,type:'finance-code-dictionaries'}});expect(ids.map(id=>sorted.find(r=>r.id===id)!.data.sort)).toEqual(ids.map((_,i)=>(i+1)*10));
  await expect(svc.reorderCategories(actor,'finance-code-dictionaries',[...ids,variety.id])).rejects.toThrow(/完整/);
  await expect(svc.reorderCategories(actor,'finance-code-dictionaries',ids.slice(1))).rejects.toThrow(/完整|无效/);
  await expect(svc.reorderCategories(other,'finance-code-dictionaries',ids)).rejects.toThrow();
 });
 it('有实际引用保留code/kind身份，可改名；统一删除保护引用',async()=>{
  const item=await create('合成已用分类',{code:'USED'});
  const base=await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:actor.companyId,type:'finance-base-codes',title:'合成已用编码',data:{code:'CODE-USED',codeDictionaryCategoryId:item.id,categoryId:4321},status:'pending',createdBy:actor.id,updatedBy:actor.id}));
  await ds.manager.save(ResourceLink,ds.manager.create(ResourceLink,{companyId:actor.companyId,sourceType:'finance-base-codes',sourceId:base.id,targetType:'finance-code-dictionaries',targetId:item.id,relation:'codeDictionaryCategoryId'}));
  await expect(svc.update(actor,'finance-code-dictionaries',item.id,{code:'CHANGED'})).rejects.toThrow(/引用/);
  await expect(svc.update(actor,'finance-code-dictionaries',item.id,{kind:'variety'})).rejects.toThrow(/引用/);
  expect((await svc.update(actor,'finance-code-dictionaries',item.id,{name:'合成改名'})).data.code).toBe('USED');
  await expect(svc.remove(actor,'finance-code-dictionaries',item.id,'合成删除')).rejects.toThrow(/引用|关联|使用/);
  const overview=await new BaseCodeToolsService(ds,svc,new OutboxService(ds,svc)).overview(actor);
  expect(overview.byCategory['4321']).toEqual({pending:1});expect(overview.byCodeCategory[String(item.id)]).toEqual({pending:1});
 });
});
