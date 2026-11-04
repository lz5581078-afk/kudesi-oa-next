import 'reflect-metadata';
import {randomBytes} from 'crypto';
import {DataSource} from 'typeorm';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,User,ResourceRecord,ResourceChangeLog,OutboxJob} from '../entities';
import {aliasCode} from './base-code-support';
import {deriveProductFinishedNames} from './product-reference-finished-names';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('R05原料成品名查看只读事实（隔离MySQL）',()=>{
 let ds:DataSource,companyId:number,otherId:number,userId:number;
 const create=(type:string,data:Record<string,unknown>,o:{companyId?:number;status?:string;archivedAt?:Date}={})=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:o.companyId??companyId,type,title:'纯合成事实',data,status:o.status??'active',archivedAt:o.archivedAt??null,createdBy:userId,updatedBy:userId}));
 beforeAll(async()=>{ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:false} as never).initialize();[companyId,otherId]=(await ds.manager.save(Company,['本','外'].map(s=>ds.manager.create(Company,{code:'af'+randomBytes(7).toString('hex'),name:'马甲投影'+s,status:'active'})))).map(c=>c.id);userId=(await ds.manager.save(User,ds.manager.create(User,{companyId,account:'admin',name:'合成马甲核对',passwordHash:'synthetic',status:'active',isCompanyAdmin:true}))).id;await create('finance-product-units',{kind:'spec_unit',code:'REALKG',name:'实际千克'});});
 afterAll(async()=>{await ds?.destroy();});
 it('迁移别名按真实name取保留业务code；新canonical实际code同样可读，未生成/重复关系未知',async()=>{
  const p=await create('finance-products',{archiveType:'raw',rawFinishedNames:'迁移别名\n新别名\n未生成\n冲突别名',specQty:1,specUnit:'REALKG',materialCode:'M'}),root=await create('finance-base-codes',{productId:p.id,code:'ROOT'});
  await create('finance-base-codes',{productId:p.id,canonicalId:root.id,aliasKey:aliasCode(companyId,p.id,'迁移别名'),migratedAliasName:'迁移别名',code:'YL-TRUE-LEGACY',purchasePrice:987654,private:'不可返回'});
  const newCode=aliasCode(companyId,p.id,'新别名');await create('finance-base-codes',{productId:p.id,canonicalId:root.id,aliasKey:newCode,code:newCode});
  for(const code of ['冲突A','冲突B'])await create('finance-base-codes',{productId:p.id,canonicalId:root.id,aliasKey:aliasCode(companyId,p.id,'冲突别名'),code});
  const facts=(await deriveProductFinishedNames(ds.manager,companyId,[p])).get(p.id)!;expect(facts.map(({name,code,fullName})=>({name,code,fullName}))).toEqual([{name:'迁移别名',code:'YL-TRUE-LEGACY',fullName:'迁移别名-1-实际千克-M'},{name:'新别名',code:newCode,fullName:'新别名-1-实际千克-M'},{name:'未生成',code:null,fullName:'未生成-1-实际千克-M'},{name:'冲突别名',code:null,fullName:'冲突别名-1-实际千克-M'}]);expect(JSON.stringify(facts)).not.toMatch(/987654|private|不可返回/);
 });
 it('跨公司alias/父canonical/单位和另一商品canonical均不能回填同名code',async()=>{
  const p=await create('finance-products',{archiveType:'raw',rawFinishedNames:'同名',specQty:2,specUnit:'FOREIGNUNIT'}),otherProduct=await create('finance-products',{archiveType:'raw',rawFinishedNames:'同名'}),otherRoot=await create('finance-base-codes',{productId:otherProduct.id});
  await create('finance-product-units',{kind:'spec_unit',code:'FOREIGNUNIT',name:'外公司隐藏单位'},{companyId:otherId});
  await create('finance-base-codes',{productId:p.id,canonicalId:otherRoot.id,migratedAliasName:'同名',code:'错商品不可返回'});
  const foreignRoot=await create('finance-base-codes',{productId:p.id},{companyId:otherId});await create('finance-base-codes',{productId:p.id,canonicalId:foreignRoot.id,migratedAliasName:'同名',code:'跨公司父不可返回'});
  await create('finance-base-codes',{productId:p.id,canonicalId:otherRoot.id,migratedAliasName:'同名',code:'跨公司alias不可返回'},{companyId:otherId});
  const result=await deriveProductFinishedNames(ds.manager,companyId,[p,{...p,companyId:otherId,id:999999}]);expect(result.size).toBe(1);expect(result.get(p.id)).toEqual([{name:'同名',code:null,fullName:'同名-2-FOREIGNUNIT',aliasRecordId:null,version:null,rowToken:null}]);
 });
 it('205产品完整批量只读2次白名单SELECT；删除/归档alias不参与，无保存/审计/队列',async()=>{
  const products=await ds.manager.save(ResourceRecord,Array.from({length:205},(_,i)=>ds.manager.create(ResourceRecord,{companyId,type:'finance-products',title:'合成'+i,status:'active',data:{archiveType:'raw',rawFinishedNames:'别名'+i,specQty:1,specUnit:'REALKG'},createdBy:userId,updatedBy:userId})));
  const roots=await ds.manager.save(ResourceRecord,products.map(p=>ds.manager.create(ResourceRecord,{companyId,type:'finance-base-codes',title:'主码',status:'active',data:{productId:p.id},createdBy:userId,updatedBy:userId})));
  await ds.manager.save(ResourceRecord,products.map((p,i)=>ds.manager.create(ResourceRecord,{companyId,type:'finance-base-codes',title:'别名码',status:'active',data:{productId:p.id,canonicalId:roots[i].id,migratedAliasName:'别名'+i,code:'REAL-'+i},createdBy:userId,updatedBy:userId})));
  for(const o of [{status:'deleted'},{archivedAt:new Date()}])await create('finance-base-codes',{productId:products[0].id,canonicalId:roots[0].id,migratedAliasName:'别名0',code:'不可算成重复'},o);
  const before=await ds.manager.find(ResourceRecord,{where:{companyId},order:{id:'ASC'}}),counts=async()=>[await ds.manager.count(ResourceChangeLog,{where:{companyId}}),await ds.manager.count(OutboxJob,{where:{companyId}})],initial=await counts();const runner=ds.createQueryRunner();await runner.connect();
  try{const query=jest.spyOn(runner,'query'),result=await deriveProductFinishedNames(runner.manager,companyId,products);expect(result.size).toBe(205);expect(result.get(products[204].id)?.[0]).toMatchObject({name:'别名204',code:'REAL-204',fullName:'别名204-1-实际千克'});expect(result.get(products[204].id)?.[0].aliasRecordId).toEqual(expect.any(Number));expect(result.get(products[204].id)?.[0].version).toMatch(/^[a-f0-9]{16}$/);expect(result.get(products[0].id)?.[0].code).toBe('REAL-0');expect(query).toHaveBeenCalledTimes(2);for(const [sql]of query.mock.calls){expect(sql).toMatch(/^SELECT /);expect(sql).not.toMatch(/purchasePrice|private|LIMIT|OFFSET/);}}finally{await runner.release();}
  expect(await ds.manager.find(ResourceRecord,{where:{companyId},order:{id:'ASC'}})).toEqual(before);expect(await counts()).toEqual(initial);
 });
 it('空/非原料输入不查询，也不造别名事实',async()=>{const runner=ds.createQueryRunner();await runner.connect();try{const query=jest.spyOn(runner,'query');expect((await deriveProductFinishedNames(runner.manager,companyId,[])).size).toBe(0);expect(query).not.toHaveBeenCalled();}finally{await runner.release();}});
});
