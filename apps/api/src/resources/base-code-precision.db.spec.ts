import 'reflect-metadata';
import {randomBytes} from 'crypto';
import {DataSource} from 'typeorm';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,ResourceRecord,User,ResourceChangeLog,OutboxJob} from '../entities';
import {baseCodeOutbound,composedFacts} from './base-code-support';
import {buildServices} from '../test-support';
import {BaseCodeToolsService} from './base-code-tools.service';
import {OutboxService} from '../outbox/outbox.service';
import type {AuthUser} from '../common/auth.decorators';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('基础编码组成报价终点精度',()=>{
 let ds:DataSource,user:AuthUser,foreign:number;
 const put=(type:string,data:Record<string,unknown>,companyId=user.companyId)=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{type,companyId,title:String(data.name||data.code||'合成精度'),data,status:'active',createdBy:user.id,updatedBy:user.id}));
 beforeAll(async()=>{ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:false} as never).initialize();const companies=await ds.manager.save(Company,['本','外'].map(s=>ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'合成报价'+s,status:'active'})));foreign=companies[1].id;const actor=await ds.manager.save(User,ds.manager.create(User,{companyId:companies[0].id,account:'precision',name:'合成人员',passwordHash:'x',isCompanyAdmin:true,status:'active',mustChangePassword:false}));user={id:actor.id,companyId:actor.companyId,name:actor.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};});
 afterAll(async()=>{await ds?.destroy();});
 it('真实V3元4位终点：先合计完整乘积再一次舍入，只读不改原八位成本或队列',async()=>{
  const base=await put('finance-base-codes',{origin:'composed',code:'PRECISION-BASE',cost:0.01,purchasePrice:0.01});
  for(let i=0;i<2;i++){const p=await put('finance-products',{archiveType:'self_made',name:'低价组成'+i,totalCost:0.000101,freight:0,handlingFee:0,weightG:1});await put('finance-base-code-lines',{baseCodeId:base.id,productId:p.id,qty:49});}
  const before=await ds.manager.find(ResourceRecord,{where:{companyId:user.companyId},order:{id:'ASC'}}),logs=await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}}),jobs=await ds.manager.count(OutboxJob,{where:{companyId:user.companyId}});
  // Each line is 0.004949 cents (would round to 0 independently); the source aggregate is 0.009898 -> 0.01 cents.
  expect(await composedFacts(ds.manager,user.companyId,base.id)).toMatchObject({cost:0.01,purchasePrice:0.01,weightG:98,count:2});expect(await baseCodeOutbound(ds.manager,user.companyId,base)).toMatchObject({cost_price:0.0001,purchase_price:0.0001});
  expect(await ds.manager.find(ResourceRecord,{where:{companyId:user.companyId},order:{id:'ASC'}})).toEqual(before);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}})).toBe(logs);expect(await ds.manager.count(OutboxJob,{where:{companyId:user.companyId}})).toBe(jobs);
 });
 it('八位元物流进入组成完整乘积；采购事实扣本档物流，空缺和跨公司来源保持null',async()=>{
  const base=await put('finance-base-codes',{origin:'composed',code:'PRECISE-LOGISTICS'}),p=await put('finance-products',{archiveType:'self_made',totalCost:100.123456,freight:0.000001,handlingFee:0.000002,weightG:10});await put('finance-base-code-lines',{baseCodeId:base.id,productId:p.id,qty:1.123456});
  // Independent integer-ratio expectation: full product then yuan4 endpoint.
  expect((await composedFacts(ds.manager,user.companyId,base.id))).toMatchObject({cost:112.48,purchasePrice:112.48,weightG:11.23456});
  const missing=await put('finance-products',{archiveType:'raw',weightG:1},foreign);await put('finance-base-code-lines',{baseCodeId:base.id,productId:missing.id,qty:1});expect(await composedFacts(ds.manager,user.companyId,base.id)).toMatchObject({cost:null,purchasePrice:null});
  const empty=await put('finance-base-codes',{origin:'composed'});expect(await composedFacts(ds.manager,user.companyId,empty.id)).toMatchObject({cost:null,purchasePrice:null,count:0});
 });
 it('档案直连只取真实已存元4位价，独立导入报价六位元不截断，普通输入不放宽',async()=>{
  const p=await put('finance-products',{archiveType:'package',purchasePrice:100.123456,totalCost:100.123456,weightG:1});const linked=await put('finance-base-codes',{code:'ARCHIVE-LINK',productId:p.id,cost:100.12,purchasePrice:100.12});expect(await baseCodeOutbound(ds.manager,user.companyId,linked)).toMatchObject({cost_price:1.0012,purchase_price:1.0012});
  const alias=await put('finance-base-codes',{code:'ALIASED-QUOTE',canonicalId:linked.id,productId:p.id,cost:99999,purchasePrice:88888});expect(await baseCodeOutbound(ds.manager,user.companyId,alias)).toMatchObject({sku_id:'ALIASED-QUOTE',cost_price:1.0012,purchase_price:1.0012});
  const unknown=await put('finance-base-codes',{code:'UNKNOWN-QUOTE',productId:p.id});expect(await baseCodeOutbound(ds.manager,user.companyId,unknown)).toMatchObject({cost_price:null,purchase_price:null});
  const foreignBase=await put('finance-base-codes',{cost:88888},foreign),forged=await put('finance-base-codes',{canonicalId:foreignBase.id,cost:77777});expect((await baseCodeOutbound(ds.manager,user.companyId,forged)).cost_price).toBeNull();
  const external=await put('finance-base-codes',{origin:'external_import',code:'EXTERNAL-QUOTE',cost:123.4567,externalPurchasePrice:101.2345});expect(await baseCodeOutbound(ds.manager,user.companyId,external)).toMatchObject({cost_price:1.234567,purchase_price:1.012345});
  const svc=buildServices(ds).resources,cat=await svc.create(user,'finance-categories',{archiveType:'package',name:'精度包装',code:'PREC8'});await expect(svc.create(user,'finance-products',{archiveType:'package',categoryId:cat.id,name:'不放宽采购价',purchasePrice:1.123456,freight:0,handlingFee:0})).rejects.toThrow(/小数|精度/);
 });
 it('实际报告仍按成本权限脱敏、token公司拒绝跨公司，GET不写资源日志队列',async()=>{
  const p=await put('finance-products',{archiveType:'package',name:'报告来源',totalCost:123.456789,purchasePrice:100,weightG:1}),b=await put('finance-base-codes',{productId:p.id,code:'REPORT-STORED',cost:123.46});
  const svc=buildServices(ds).resources,tools=new BaseCodeToolsService(ds,svc,new OutboxService(ds,svc)),before=await ds.manager.find(ResourceRecord,{where:{companyId:user.companyId},order:{id:'ASC'}}),logs=await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}}),jobs=await ds.manager.count(OutboxJob,{where:{companyId:user.companyId}});
  expect((await tools.report(user,b.id)).outbound.values.cost_price).toBe(1.2346);const viewer={...user,permissions:{isCompanyAdmin:false,allow:['resource.finance-base-codes.view'],deny:['product.cost.view']}};const hidden=(await tools.report(viewer,b.id)).outbound.values;expect(hidden).not.toHaveProperty('cost_price');expect(hidden).not.toHaveProperty('purchase_price');
  const other=await put('finance-base-codes',{code:'FOREIGN-REPORT',cost:99999},foreign);await expect(tools.report(user,other.id)).rejects.toMatchObject({status:404});
  expect(await ds.manager.find(ResourceRecord,{where:{companyId:user.companyId},order:{id:'ASC'}})).toEqual(before);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}})).toBe(logs);expect(await ds.manager.count(OutboxJob,{where:{companyId:user.companyId}})).toBe(jobs);
 });
 it('OEM actual saved total purchase 6.7 is distinct from raw purchase 6.5',async()=>{
  const svc=buildServices(ds).resources,brandId=(await svc.create(user,'finance-brands',{name:'OEM brand'})).id,packCat=(await svc.create(user,'finance-categories',{archiveType:'oem_package',name:'OEM package',code:'PKC'})).id,oemCat=(await svc.create(user,'finance-categories',{archiveType:'supplier_oem',name:'OEM product',code:'OEMC'})).id;
  const pack=await svc.create(user,'finance-products',{archiveType:'oem_package',categoryId:packCat,brandId,name:'OEM wrapper',packagingCategory:'bag',capacities:'500G',specQty:500,specUnit:'G',purchaseSpec:'KG',weightG:10,purchasePrice:8,freight:1,handlingFee:1});
  const source=await svc.create(user,'finance-products',{archiveType:'purchased',supplyMode:'supplier_oem',categoryId:oemCat,brandId,name:'OEM product',specQty:500,specUnit:'G',purchaseSpec:'KG',purchasePrice:650,freight:20,handlingFee:10});await svc.create(user,'finance-product-boms',{productId:source.id,componentId:pack.id,qty:2.5});
  const base=(await svc.list(user,'finance-base-codes',{fieldKey:'productId',fieldValue:String(source.id),showHidden:true,pageSize:200})).items.find(row=>!row.data.canonicalId)!;
  expect(base.data).toMatchObject({cost:700,purchasePrice:670});const real=await ds.manager.findOneByOrFail(ResourceRecord,{id:base.id,companyId:user.companyId,type:'finance-base-codes'});expect(await baseCodeOutbound(ds.manager,user.companyId,real)).toMatchObject({cost_price:7,purchase_price:6.7});
 });
});
