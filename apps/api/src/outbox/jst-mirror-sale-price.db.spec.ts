import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, OutboxJob, ResourceChangeLog, ResourceRecord } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from '../resources/resources.service';
import { recordTrustedJstMirrorSalePrice } from './jst-mirror-sale-price';
import { OutboxService, type OutboxSender } from './outbox.service';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('普通商品已确认回读的售价白名单镜像（隔离数据库）',()=>{
 let ds:DataSource,resources:ResourcesService,a:number,b:number;
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();resources=buildServices(ds).resources;
  const company=async()=> (await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'合成可信镜像',status:'active'}))).id;
  a=await company();b=await company();
 });
 afterAll(async()=>{await ds?.destroy();});
 const row=(companyId:number,sku:string)=>ds.manager.findOneBy(ResourceRecord,{companyId,type:'finance-jst-skus',uniqueKey:sku.toLowerCase()});
 it('SKU身份核对、公司隔离、0/六位元售价、缺失保留、重复回读幂等且成本/敏感raw不落库',async()=>{
  const warn=jest.fn(),sku='MIRROR-SAFE';
  await recordTrustedJstMirrorSalePrice(ds,resources,a,sku,{sku_id:'WRONG',s_price:9},warn);expect(await row(a,sku)).toBeNull();
  const payload={sku_id:sku,i_id:'STYLE',name:'合成镜像',s_price:'3.123456',cost_price:900,purchase_price:800,secret:'不能落库',raw:{other:'不能落库'}};
  await recordTrustedJstMirrorSalePrice(ds,resources,a,sku,payload,warn);
  const first=(await row(a,sku))!;expect(first.data).toEqual({skuId:sku,goodsType:'normal',styleId:'STYLE',name:'合成镜像',salePrice:312.3456});
  const logCount=await ds.manager.countBy(ResourceChangeLog,{companyId:a,resourceType:'finance-jst-skus',resourceId:first.id});
  await recordTrustedJstMirrorSalePrice(ds,resources,a,sku,payload,warn);
  expect(await ds.manager.countBy(ResourceChangeLog,{companyId:a,resourceType:'finance-jst-skus',resourceId:first.id})).toBe(logCount);expect(await ds.manager.countBy(ResourceRecord,{companyId:a,type:'finance-jst-skus'})).toBe(1);
  await recordTrustedJstMirrorSalePrice(ds,resources,b,sku,{sku_id:sku,sale_price:0},warn);expect((await row(b,sku))?.data.salePrice).toBe(0);expect((await row(a,sku))?.data.salePrice).toBe(312.3456);
  await recordTrustedJstMirrorSalePrice(ds,resources,a,sku,{sku_id:sku},warn);expect((await row(a,sku))?.data.salePrice).toBe(312.3456);
  for(const value of ['3.1234567',-1,'Infinity','9999999999999999999999999999'])await recordTrustedJstMirrorSalePrice(ds,resources,a,sku,{sku_id:sku,s_price:value},warn);
  expect((await row(a,sku))?.data.salePrice).toBe(312.3456);expect(warn).toHaveBeenCalled();
 });
 it('无效上游售价不使已确认普通商品触发发送或确认重试',async()=>{
  const sender:OutboxSender={configured:true,send:jest.fn(),read:jest.fn().mockResolvedValue({sku_id:'MIRROR-INVALID',s_price:'0.1234567'})};
  const outbox=new OutboxService(ds,resources,sender);
  const job=Object.assign(new OutboxJob(),{companyId:a,resourceType:'finance-base-codes',kind:'base_code_upsert',payloadJson:{sku_id:'MIRROR-INVALID'}});
  await (outbox as unknown as {confirm(job:OutboxJob,result:undefined,sender:OutboxSender):Promise<void>}).confirm(job,undefined,sender);
  expect(sender.read).toHaveBeenCalledTimes(1);expect(sender.send).not.toHaveBeenCalled();expect((await row(a,'MIRROR-INVALID'))?.data).not.toHaveProperty('salePrice');
 });
});
