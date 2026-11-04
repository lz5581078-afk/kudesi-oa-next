import 'reflect-metadata';
import {randomBytes} from 'crypto';
import {DataSource} from 'typeorm';
import {Company,ResourceRecord,ResourceChangeLog,User} from '../entities';
import {buildDataSourceOptions} from '../database/data-source';
import type {AuthUser} from '../common/auth.decorators';
import {buildServices} from '../test-support';
import {deriveBaseCodeListFacts} from './base-code-list-facts';
import {buildSnapshot} from './base-code-support';
import {snapshotReadContext} from './snapshot-read-context';
const db=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
db('基础编码列表复用真实报表的只读批次事实',()=>{
 let ds:DataSource,svc:ReturnType<typeof buildServices>['resources'],user:AuthUser,product:ResourceRecord,category:number,brand:number;
 const fixture=async(type:string,data:Record<string,unknown>,status='pending',companyId=user.companyId)=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId,type,title:String(data.name||'合成'),status,data,createdBy:user.id,updatedBy:user.id}));
 const base=(data:Record<string,unknown>={},status='pending',companyId=user.companyId)=>fixture('finance-base-codes',{productId:product.id,code:'HC-'+randomBytes(4).toString('hex'),name:'合成列表编码',...data},status,companyId);
 beforeAll(async()=>{ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();svc=buildServices(ds).resources;});
 afterAll(async()=>{await ds?.destroy();});
 beforeEach(async()=>{const company=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'合成列表公司',status:'active'})),person=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'synthetic',passwordHash:'unused',name:'合成管理员',isCompanyAdmin:true,status:'active',mustChangePassword:false}));user={id:person.id,companyId:company.id,name:person.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
  const root=await svc.create(user,'finance-categories',{archiveType:'raw',name:'合成原料',code:'HC'}),leaf=await svc.create(user,'finance-categories',{archiveType:'raw',name:'合成苹果',code:'PG',parentId:root.id});brand=(await svc.create(user,'finance-brands',{name:'合成品牌',code:'HC'})).id;category=(await svc.create(user,'finance-code-dictionaries',{kind:'product_category',name:'合成编码分类',code:'HC'})).id;await svc.create(user,'finance-product-units',{kind:'spec_unit',name:'千克',code:'KG'});
  const created=await svc.create(user,'finance-products',{archiveType:'raw',name:'合成来源苹果',categoryId:leaf.id,specQty:1,specUnit:'KG',purchaseSpec:'千克',purchasePrice:100,freight:1,handlingFee:1});product=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:user.companyId,id:created.id});
 });
 it('缓存批次与普通报告逐字等价，实际get/list只投影项数/真身关系不泄漏成本',async()=>{
  const record=await base(),ordinary=await buildSnapshot(ds.manager,user.companyId,record),cached=await buildSnapshot(ds.manager,user.companyId,record,snapshotReadContext(ds.manager,user.companyId));expect(cached).toEqual(ordinary);
  const reader=snapshotReadContext(ds.manager,user.companyId);await expect(buildSnapshot(ds.manager,user.companyId+1,record,reader)).rejects.toThrow('上下文不匹配');const runner=ds.createQueryRunner();try{await expect(buildSnapshot(runner.manager,user.companyId,record,reader)).rejects.toThrow('上下文不匹配');}finally{await runner.release();}
  const before=await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}}),facts=(await deriveBaseCodeListFacts(ds.manager,user.companyId,[record])).get(record.id)!;expect(facts).toMatchObject({issueCount:ordinary.issues.length,canonicalId:record.id,canonicalState:'pending',aliasCount:0});
  const viewer:AuthUser={...user,permissions:{isCompanyAdmin:false,allow:['resource.finance-base-codes.view'],deny:['product.cost.view','product.price.view']}};
  const get=await svc.get(viewer,'finance-base-codes',record.id),list=await svc.list(viewer,'finance-base-codes',{pageSize:100});expect(get.baseCodeFacts).toEqual(facts);expect(list.items.find(row=>row.id===record.id)!.baseCodeFacts).toEqual(facts);expect(get.data).not.toHaveProperty('cost');expect(get.data).not.toHaveProperty('snapshot');expect(JSON.stringify(get.baseCodeFacts)).not.toMatch(/unitCost|freight|purchasePrice|costPrice/);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}})).toBe(before);
  product.data.totalCost=null;await ds.manager.save(product);const next=await svc.get(viewer,'finance-base-codes',record.id);expect(next.baseCodeFacts!.issueCount).toBe(ordinary.issues.length+1);expect((await buildSnapshot(ds.manager,user.companyId,record)).issues.length).toBe(next.baseCodeFacts!.issueCount);
 });
 it('真身/马甲数仅同公司真实关系，未知阶段与失效跨公司链接不伪装成待验证或成功',async()=>{
  const real=await base({},'verified'),alias=await base({canonicalId:real.id}),second=await base({canonicalId:real.id},'reverify');await base({canonicalId:real.id},'deleted');
  const foreignCompany=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'其他合成公司',status:'active'})),foreign=await base({},'verified',foreignCompany.id);await base({canonicalId:real.id},'pending',foreignCompany.id);
  const bad=await base({canonicalId:foreign.id}),unknown=await base({},'disabled');const facts=await deriveBaseCodeListFacts(ds.manager,user.companyId,[real,alias,second,bad,unknown,foreign]);
  expect(facts.get(real.id)).toMatchObject({canonicalId:real.id,canonicalState:'verified',aliasCount:2});for(const row of [alias,second])expect(facts.get(row.id)).toMatchObject({canonicalId:real.id,canonicalState:'verified',aliasCount:0});expect(facts.get(bad.id)).toMatchObject({canonicalId:null,canonicalState:null,aliasCount:0});expect(facts.get(bad.id)!.issueCount).toBeGreaterThan(0);expect(facts.get(unknown.id)).toMatchObject({canonicalId:unknown.id,canonicalState:null});expect(facts.has(foreign.id)).toBe(false);
 });
 it('同源100个独立编码共享来源/分类/单位Promise读取，批次无全公司来源扫描或线性重复',async()=>{
  const records=await ds.manager.save(ResourceRecord,Array.from({length:100},(_,i)=>ds.manager.create(ResourceRecord,{companyId:user.companyId,type:'finance-base-codes',title:'同源独立'+i,status:'pending',data:{origin:'composed',name:'同源独立'+i,code:'HC-'+i,codeDictionaryCategoryId:category,codeBrandId:brand,varietyName:'苹果',codeSpecQty:1,codeSpecUnit:'KG'},createdBy:user.id,updatedBy:user.id})));
  await ds.manager.save(ResourceRecord,records.map(record=>ds.manager.create(ResourceRecord,{companyId:user.companyId,type:'finance-base-code-lines',title:'合成组成',status:'active',data:{baseCodeId:record.id,productId:product.id,qty:1,role:'main'},createdBy:user.id,updatedBy:user.id})));
  const runner=ds.createQueryRunner();await runner.connect();const spy=jest.spyOn(runner,'query');try{
   const one=await deriveBaseCodeListFacts(runner.manager,user.companyId,[records[0]]),single=spy.mock.calls.filter(([sql])=>String(sql).startsWith('SELECT')).length;spy.mockClear();const all=await deriveBaseCodeListFacts(runner.manager,user.companyId,records),queries=spy.mock.calls.filter(([sql])=>String(sql).startsWith('SELECT'));
   expect(all.size).toBe(100);expect([...all.values()].every(row=>row.issueCount===one.get(records[0].id)!.issueCount)).toBe(true);expect(queries.length).toBeLessThanOrEqual(single+1);expect(queries.length).toBeLessThan(20);
   const sourceQueries=queries.filter(([,params])=>Array.isArray(params)&&params.includes('finance-products'));expect(sourceQueries).toHaveLength(1);expect(sourceQueries[0][1]).toContain(product.id);
  }finally{spy.mockRestore();await runner.release();}
  const normal=await buildSnapshot(ds.manager,user.companyId,records[0]),cached=await buildSnapshot(ds.manager,user.companyId,records[0],snapshotReadContext(ds.manager,user.companyId));expect(cached).toEqual(normal);
 });
});
