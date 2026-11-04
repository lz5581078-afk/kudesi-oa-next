import {INestApplication} from '@nestjs/common';
import {APP_GUARD} from '@nestjs/core';
import {Test} from '@nestjs/testing';
import {PermissionsGuard} from '../common/permissions.guard';
import {BundleToolsController} from './bundle-tools.controller';
import 'reflect-metadata';
import {randomBytes} from 'crypto';
import {DataSource} from 'typeorm';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,ResourceRecord,User,Position,OutboxJob,AuditLog,ResourceChangeLog} from '../entities';
import {buildServices} from '../test-support';
import {OutboxService} from '../outbox/outbox.service';
import {BundleToolsService} from './bundle-tools.service';
import type {AuthUser} from '../common/auth.decorators';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('组合查看详情真实当前组成与历史成本（只读）',()=>{
 let app:INestApplication,url:string;
 let ds:DataSource,tools:BundleToolsService,actor:AuthUser,bundle:ResourceRecord,base:ResourceRecord,alias:ResourceRecord,foreign:number;
 const put=(type:string,data:Record<string,unknown>,companyId=actor.companyId,status='active')=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId,type,title:String(data.name||data.code||'合成详情'),data,status,createdBy:actor.id,updatedBy:actor.id}));
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();const services=buildServices(ds);tools=new BundleToolsService(ds,services.resources,new OutboxService(ds,services.resources));
  const company=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'详情合成',status:'active'}));foreign=(await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'详情隔离',status:'active'}))).id;
  const user=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'detail',name:'合成人员',passwordHash:'x',isCompanyAdmin:true,mustChangePassword:false,status:'active'}));actor={id:user.id,companyId:company.id,name:user.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
  const product=await put('finance-products',{archiveType:'raw',name:'真实当前原料',totalCost:99.1234,weightG:1000});base=await put('finance-base-codes',{productId:product.id,code:'DETAIL-REAL',name:'真实基础',cost:99.123456});alias=await put('finance-base-codes',{canonicalId:base.id,code:'DETAIL-ALIAS',name:'原料成品名',cost:99999});
  await put('finance-jst-skus',{goodsType:'normal',skuId:'DETAIL-REAL',salePrice:500});await put('finance-jst-skus',{goodsType:'normal',skuId:'DETAIL-ALIAS',salePrice:99999});await put('finance-jst-skus',{goodsType:'normal',skuId:'DETAIL-REAL',salePrice:88888},foreign);
  bundle=await put('finance-bundles',{code:'DETAIL-BUNDLE',name:'查看合成',styleCode:'DETAIL-STYLE'});
  await put('finance-bundle-lines',{bundleId:bundle.id,baseCodeId:alias.id,role:'main',qty:2});await put('finance-bundle-lines',{bundleId:bundle.id,baseCodeId:alias.id,role:'gift',qty:1});
  const version=await put('finance-cost-versions',{name:'实际锁定版',lockedAt:'2026-11-01',effectiveFrom:'2026-01-01'});
  await put('finance-cost-skus',{versionId:version.id,skuType:'bundle',bundleId:bundle.id,snapshot:{skuType:'bundle',skuId:bundle.id,costIncludingFreightCents:8888}});
  await put('finance-cost-skus',{versionId:version.id,skuType:'base_code',baseCodeId:base.id,snapshot:{skuType:'base_code',skuId:base.id,costIncludingFreightCents:123.4567}});
  const revision=await put('finance-bundle-revisions',{bundleId:bundle.id,payload:{version:1,sourceToken:'a'.repeat(64),lines:[{baseCodeId:alias.id,role:'main',qty:999}]}},actor.companyId,'pending');await ds.manager.update(ResourceRecord,{id:bundle.id},{data:{...bundle.data,pendingRevisionId:revision.id}});
 });
 afterAll(async()=>{await app?.close();await ds?.destroy();});
 it('锁定基础SKU单价不同于组合总额/当前价，马甲按真实编码取镜像；不取待修改行且全程无写',async()=>{
  const count=await ds.manager.count(ResourceRecord,{where:{companyId:actor.companyId}}),jobs=await ds.manager.count(OutboxJob,{where:{companyId:actor.companyId}});
  const detail=(await tools.composition(actor,bundle.id)).referenceDetail;
  expect(detail.lines).toHaveLength(2);expect(detail.lines[0]).toMatchObject({name:'原料成品名',qty:2,cost:123.4567,costSubtotal:246.9134,costSource:'SKU成本快照',saleSubtotal:1000,isRawFinishedName:true,weightG:2000});expect(detail.lines[1].saleSubtotal).toBe(0);
  expect(await ds.manager.count(ResourceRecord,{where:{companyId:actor.companyId}})).toBe(count);expect(await ds.manager.count(OutboxJob,{where:{companyId:actor.companyId}})).toBe(jobs);
 });
 it('四组合读ACL独立；未知价格不造0；其他公司ID404',async()=>{
  for(const cost of [false,true])for(const price of [false,true]){const viewer={...actor,permissions:{isCompanyAdmin:false,allow:['resource.finance-bundles.view',...(cost?['product.cost.view']:[]),...(price?['product.price.view']:[])],deny:[]}};const detail=(await tools.composition(viewer,bundle.id)).referenceDetail;expect('costSubtotal'in detail.lines[0]).toBe(cost);expect('saleSubtotal'in detail.lines[0]).toBe(price);expect('costVersionName'in detail).toBe(cost);}
  const other=await put('finance-bundles',{code:'FOREIGN-DETAIL'},foreign);await expect(tools.composition(actor,other.id)).rejects.toMatchObject({status:404});
  const empty=await put('finance-base-codes',{code:'UNKNOWN-DETAIL'}),b=await put('finance-bundles',{code:'UNKNOWN-BUNDLE'});await put('finance-bundle-lines',{bundleId:b.id,baseCodeId:empty.id,role:'main',qty:1});expect((await tools.composition(actor,b.id)).referenceDetail.lines[0]).toMatchObject({cost:null,costSubtotal:null,saleSubtotal:null});
 });
 it('无版本快照明确回当前基础成本，直接档案用生效成本而非档案总价，人工取真实项目；失去当前种子仍能读原快照',async()=>{
  const product=await put('finance-products',{archiveType:'package',name:'直接包装',totalCost:99999,weightG:5,systemSpec:'1张'});
  await put('finance-product-costs',{productId:product.id,costType:'purchase',unitCost:10,effectiveFrom:'2020-01-01'});await put('finance-product-costs',{productId:product.id,costType:'production',unitCost:2,effectiveFrom:'2020-01-01'});await put('finance-product-costs',{productId:product.id,costType:'purchase',unitCost:88888,effectiveFrom:'2099-01-01'});await put('finance-product-costs',{productId:product.id,costType:'purchase',unitCost:77777,effectiveFrom:'2020-01-01'},foreign);
  const labor=await put('finance-labor-costs',{name:'实际人工',unitPrice:3,unitName:'次'}),b=await put('finance-bundles',{code:'CURRENT-FALLBACK'});
  await put('finance-bundle-lines',{bundleId:b.id,baseCodeId:base.id,role:'main',qty:1});await put('finance-bundle-lines',{bundleId:b.id,productId:product.id,role:'package',qty:2});await put('finance-bundle-lines',{bundleId:b.id,laborId:labor.id,role:'labor',qty:3});
  const detail=(await tools.composition(actor,b.id)).referenceDetail;expect(detail.lines[0]).toMatchObject({cost:99.123456,costSource:'基础编码当前成本'});expect(detail.lines[1]).toMatchObject({cost:12,costSubtotal:24,costSource:'商品档案成本',spec:'1张'});expect(detail.lines[2]).toMatchObject({costSubtotal:9,unit:'次'});
  const original={...base.data};await ds.manager.update(ResourceRecord,{id:base.id},{data:{...base.data,productId:999999999}});try{expect((await tools.composition(actor,bundle.id)).referenceDetail.lines[0]).toMatchObject({cost:123.4567,costSource:'SKU成本快照'});}finally{await ds.manager.save(ResourceRecord,{...base,data:original});}
 });
 it('详情元8位终点：真实当前镜像优先于live种子/马甲伪价；档案SUM和数量完整乘积，未知不现算',async()=>{
  const b=await put('finance-bundles',{code:'EIGHT-DETAIL'});await put('finance-bundle-lines',{bundleId:b.id,baseCodeId:alias.id,role:'main',qty:1});
  const direct=await put('finance-products',{archiveType:'package',name:'八位档案',totalCost:99999,weightG:1});await put('finance-product-costs',{productId:direct.id,costType:'purchase',unitCost:12.345678,effectiveFrom:'2020-01-01'});await put('finance-product-costs',{productId:direct.id,costType:'production',unitCost:0.000001,effectiveFrom:'2020-01-01'});await put('finance-bundle-lines',{bundleId:b.id,productId:direct.id,role:'package',qty:1.234567});
  const labor=await put('finance-labor-costs',{name:'精细人工',unitPrice:0.1234,unitName:'次'});await put('finance-bundle-lines',{bundleId:b.id,laborId:labor.id,role:'labor',qty:1.234567});
  let detail=(await tools.composition(actor,b.id)).referenceDetail;expect(detail.lines[0]).toMatchObject({cost:99.123456,costSubtotal:99.123456,costSource:'基础编码当前成本'});expect(detail.lines[1]).toMatchObject({cost:12.345679,costSubtotal:15.241568,costSource:'商品档案成本'});expect(detail.lines[2]).toMatchObject({cost:0.1234,costSubtotal:0.152346});
  const original={...base.data};base.data={...base.data,cost:null};await ds.manager.save(ResourceRecord,base);try{detail=(await tools.composition(actor,b.id)).referenceDetail;expect(detail.lines[0]).toMatchObject({cost:null,costSubtotal:null,costSource:'基础编码未维护有效成本'});expect((await tools.composition(actor,bundle.id)).referenceDetail.lines[0]).toMatchObject({cost:123.4567,costSource:'SKU成本快照'});}finally{base.data=original;await ds.manager.save(ResourceRecord,base);}
  const foreignBase=await put('finance-base-codes',{cost:888888},foreign),forged=await put('finance-base-codes',{canonicalId:foreignBase.id,cost:777777});await put('finance-bundle-lines',{bundleId:b.id,baseCodeId:forged.id,role:'other',qty:1});expect((await tools.composition(actor,b.id)).referenceDetail.lines.at(-1)).toMatchObject({cost:null,costSubtotal:null});
 });
 it('真实HTTP只信token公司，view路由与四组合金额投影无写；无权限拒绝/跨公司404',async()=>{
  const module=await Test.createTestingModule({controllers:[BundleToolsController],providers:[{provide:BundleToolsService,useValue:tools},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile();
  app=module.createNestApplication();app.use((req:{headers:Record<string,string>;user?:unknown},_res:unknown,next:()=>void)=>{const auth=req.headers.authorization;if(auth){const mode=auth.replace('Bearer ','');req.user={...actor,permissions:{isCompanyAdmin:false,allow:[...(mode==='none'?[]:['resource.finance-bundles.view']),...(mode.includes('cost')?['product.cost.view']:[]),...(mode.includes('sale')?['product.price.view']:[])],deny:[]}};}next();});await app.listen(0,'127.0.0.1');url=await app.getUrl();
  const get=(id:number,mode:string)=>fetch(`${url}/finance/bundles/${id}/composition?companyId=${foreign}`,{headers:{authorization:`Bearer ${mode}`}});
  const audits=await ds.manager.count(AuditLog,{where:{companyId:actor.companyId}}),changes=await ds.manager.count(ResourceChangeLog,{where:{companyId:actor.companyId}});
  const before=await ds.manager.find(ResourceRecord,{where:{companyId:actor.companyId},order:{id:'ASC'}}),jobs=await ds.manager.count(OutboxJob,{where:{companyId:actor.companyId}});
  for(const [mode,cost,sale] of [['view',false,false],['cost',true,false],['sale',false,true],['cost-sale',true,true]] as const){const response=await get(bundle.id,mode);expect(response.status).toBe(200);const body=await response.json();expect(body.referenceDetail.code).toBe('DETAIL-BUNDLE');expect('costSubtotal'in body.referenceDetail.lines[0]).toBe(cost);expect('saleSubtotal'in body.referenceDetail.lines[0]).toBe(sale);}
  expect((await get(bundle.id,'none')).status).toBe(403);const other=await put('finance-bundles',{code:'HTTP-FOREIGN'},foreign);expect((await get(other.id,'cost-sale')).status).toBe(404);
  expect(await ds.manager.count(AuditLog,{where:{companyId:actor.companyId}})).toBe(audits);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:actor.companyId}})).toBe(changes);expect(await ds.manager.find(ResourceRecord,{where:{companyId:actor.companyId},order:{id:'ASC'}})).toEqual(before);expect(await ds.manager.count(OutboxJob,{where:{companyId:actor.companyId}})).toBe(jobs);
 });
 it('真实仓库岗位即使有两种读权限仍不回金额',async()=>{
  const position=await ds.manager.save(Position,ds.manager.create(Position,{companyId:actor.companyId,name:'详情仓库',workspaceType:'warehouse',status:'active'}));await ds.manager.update(User,{id:actor.id},{positionId:position.id});
  const viewer={...actor,permissions:{isCompanyAdmin:false,allow:['resource.finance-bundles.view','product.cost.view','product.price.view'],deny:[]}};const detail=(await tools.composition(viewer,bundle.id)).referenceDetail;expect(detail).not.toHaveProperty('costVersionName');expect(detail.lines[0]).not.toHaveProperty('cost');expect(detail.lines[0]).not.toHaveProperty('saleSubtotal');
 });
});
