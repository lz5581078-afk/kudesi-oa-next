import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, ResourceChangeLog, ResourceLink, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('独立采购变价事实（隔离数据库）',()=>{
 let ds:DataSource,svc:ResourcesService,boss:AuthUser,other:AuthUser,rawCat:number,oemCat:number,packageCat:number,brandId:number,supplierId:number;
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true} as never).initialize();svc=buildServices(ds).resources;
  const actor=async()=>{const c=await ds.manager.save(Company,ds.manager.create(Company,{code:'ph'+randomBytes(5).toString('hex'),name:'采购历史合成公司',status:'active'}));const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'admin',passwordHash:'x',name:'合成管理员',isCompanyAdmin:true,status:'active',mustChangePassword:false}));return{id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};boss=await actor();other=await actor();
  rawCat=(await svc.create(boss,'finance-categories',{archiveType:'raw',name:'合成原料类',code:'PR'})).id;oemCat=(await svc.create(boss,'finance-categories',{archiveType:'supplier_oem',name:'合成OEM类',code:'PO'})).id;packageCat=(await svc.create(boss,'finance-categories',{archiveType:'oem_package',name:'合成包装类',code:'PK'})).id;brandId=(await svc.create(boss,'finance-brands',{name:'合成品牌',code:'PH'})).id;supplierId=(await svc.create(boss,'finance-suppliers',{name:'合成供应商'})).id;
 });
 afterAll(async()=>{await ds?.destroy();});
 const raw=(over:Record<string,unknown>={})=>svc.create(boss,'finance-products',{archiveType:'raw',categoryId:rawCat,name:'合成采购'+randomBytes(3).toString('hex'),specQty:1,specUnit:'KG',purchaseSpec:'千克',purchasePrice:100,freight:1,handlingFee:1,weightG:100,...over});
 const history=async(id:number,user=boss)=>(await svc.list(user,'finance-product-purchase-history',{fieldKey:'productId',fieldValue:String(id),pageSize:200})).items;
 it('创建可信价格记首笔，仅运装/备注/系统规格变化不追加；真实六位元报价变化追加',async()=>{
  const p=await raw({purchasePrice:12.3456});expect((await history(p.id)).map(r=>r.data.purchasePrice)).toEqual([12.3456]);
  await svc.update(boss,'finance-products',p.id,{freight:2,handlingFee:3,note:'合成改备注',purchaseSpec:'斤'});
  expect(await history(p.id)).toHaveLength(1);
  await svc.update(boss,'finance-products',p.id,{purchasePrice:23.4567});
  expect((await history(p.id)).map(r=>r.data.purchasePrice).sort()).toEqual([12.3456,23.4567]);
 });
 it('旧档无可信历史不因当前值/运装更改造历史，实际改价才从当次开始',async()=>{
  const p=await raw();for(const row of await history(p.id)){await ds.manager.delete(ResourceLink,{companyId:boss.companyId,sourceType:'finance-product-purchase-history',sourceId:row.id});await ds.manager.delete(ResourceRecord,row.id);}
  await svc.update(boss,'finance-products',p.id,{freight:7,note:'旧档改说明'});
  expect(await history(p.id)).toHaveLength(0);
  await svc.update(boss,'finance-products',p.id,{purchasePrice:150});
  expect((await history(p.id)).map(r=>r.data.purchasePrice)).toEqual([150]);
 });
 it('完整表单多来源只登记最终采购价；失败、同请求重试不新增中间事实',async()=>{
  const input={requestKey:randomUUID(),values:{archiveType:'raw',categoryId:rawCat,name:'合成整组历史',specQty:1,specUnit:'KG',purchaseSpec:'千克',freight:1,handlingFee:1},collections:[{type:'finance-product-sources',expected:[],rows:[{values:{supplierId,originArea:'合成甲',purchasePrice:111}},{values:{supplierId,originArea:'合成乙',purchasePrice:222}}]}]};
  const p=await svc.saveForm(boss,'finance-products',input);expect((await history(p.id)).map(r=>r.data.purchasePrice)).toEqual([222]);
  expect((await svc.saveForm(boss,'finance-products',input)).id).toBe(p.id);expect(await history(p.id)).toHaveLength(1);
  const before=await ds.manager.countBy(ResourceRecord,{companyId:boss.companyId,type:'finance-product-purchase-history'});
  const bad={...input,requestKey:randomUUID(),values:{...input.values,name:'合成失败历史'},collections:[{...input.collections[0],rows:[input.collections[0].rows[0],{values:{supplierId:999999999,originArea:'合成错误',purchasePrice:999}}]}]};
  await expect(svc.saveForm(boss,'finance-products',bad)).rejects.toThrow();
  expect(await ds.manager.countBy(ResourceRecord,{companyId:boss.companyId,type:'finance-product-purchase-history'})).toBe(before);
  const sources=(await svc.list(boss,'finance-product-sources',{fieldKey:'productId',fieldValue:String(p.id),pageSize:200})).items;
  await svc.update(boss,'finance-product-sources',sources[0].id,{purchasePrice:333});
  expect((await history(p.id)).map(r=>r.data.purchasePrice).sort()).toEqual([222,333]);
 });
 it('OEM记录总采购价及拆分，包装变价真实追加，本档运装变化不重复',async()=>{
  const pack=await svc.create(boss,'finance-products',{archiveType:'oem_package',categoryId:packageCat,brandId,name:'合成OEM包装',packagingCategory:'bag',capacities:'500G',specQty:500,specUnit:'G',purchaseSpec:'张',weightG:10,purchasePrice:8,freight:1,handlingFee:1});
  const p=await svc.create(boss,'finance-products',{archiveType:'purchased',supplyMode:'supplier_oem',categoryId:oemCat,brandId,name:'合成OEM',specQty:500,specUnit:'G',purchaseSpec:'袋',purchasePrice:650,freight:20,handlingFee:10});
  const b=await svc.create(boss,'finance-product-boms',{productId:p.id,componentId:pack.id,qty:2.5});
  let rows=await history(p.id);expect(rows).toHaveLength(1);expect(rows[0].data).toMatchObject({purchasePrice:675,rawMaterialPurchasePrice:650,packagingCost:25,priceBasis:'oem_total'});
  await svc.update(boss,'finance-products',p.id,{freight:30});expect(await history(p.id)).toHaveLength(1);
  await svc.update(boss,'finance-products',pack.id,{purchasePrice:12});rows=await history(p.id);expect(rows).toHaveLength(2);expect(rows.map(r=>r.data.purchasePrice).sort()).toEqual([675,685]);
  await svc.update(boss,'finance-product-boms',b.id,{qty:3});expect((await history(p.id)).map(r=>r.data.purchasePrice).sort()).toEqual([675,685,692]);
 });
 it('历史最终追加失败会回滚主档/子表/审计，原请求重试只记一次',async()=>{
  const input={requestKey:randomUUID(),values:{archiveType:'raw',categoryId:rawCat,name:'合成历史追加失败',specQty:1,specUnit:'KG',purchaseSpec:'千克',freight:1,handlingFee:1},collections:[{type:'finance-product-sources',expected:[],rows:[{values:{supplierId,originArea:'合成来源',purchasePrice:456}}]}]};
  const graph=async()=>({records:(await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}})).map(row=>[row.id,row.data,row.status]),logs:(await ds.manager.find(ResourceChangeLog,{where:{companyId:boss.companyId},order:{id:'ASC'}})).map(row=>row.id)});
  const before=await graph(),create=svc.createRecord.bind(svc);
  const spy=jest.spyOn(svc,'createRecord').mockImplementation(async(...args)=>{if(args[2]==='finance-product-purchase-history')throw new Error('合成历史追加失败');return create(...args);});
  try{await expect(svc.saveForm(boss,'finance-products',input)).rejects.toThrow('合成历史追加失败');expect(await graph()).toEqual(before);}finally{spy.mockRestore();}
  const saved=await svc.saveForm(boss,'finance-products',input);
  expect((await history(saved.id)).map(row=>row.data.purchasePrice)).toEqual([456]);
  expect((await svc.saveForm(boss,'finance-products',input)).id).toBe(saved.id);expect(await history(saved.id)).toHaveLength(1);
 });
 it('OEM整组多个包装仅记最终总采购事实，不记录逐行中间组成',async()=>{
  const packaging=async(name:string,price:number)=>svc.create(boss,'finance-products',{archiveType:'oem_package',categoryId:packageCat,brandId,name,packagingCategory:'bag',capacities:'500G',specQty:500,specUnit:'G',purchaseSpec:'张',weightG:10,purchasePrice:price,freight:1,handlingFee:1});
  const a=await packaging('合成整组包装甲',8),b=await packaging('合成整组包装乙',20);
  const input={requestKey:randomUUID(),values:{archiveType:'purchased',supplyMode:'supplier_oem',categoryId:oemCat,brandId,name:'合成整组OEM历史',specQty:500,specUnit:'G',purchaseSpec:'袋',purchasePrice:650,freight:20,handlingFee:10},collections:[{type:'finance-product-boms',expected:[],rows:[{values:{componentId:a.id,qty:1}},{values:{componentId:b.id,qty:2}}]}]};
  const p=await svc.saveForm(boss,'finance-products',input),rows=await history(p.id);
  expect(rows).toHaveLength(1);expect(rows[0].data).toMatchObject({purchasePrice:704,rawMaterialPurchasePrice:650,packagingCost:54});
 });
 it('只读能力不可由管理员/伪造请求绕过，公司隔离且成本字段服务端移除',async()=>{
  const p=await raw({purchasePrice:321}),row=(await history(p.id))[0];
  await expect(svc.create(boss,'finance-product-purchase-history',{productId:p.id,purchasePrice:9,label:'伪造',recordedAtKey:'2000-01-01',priceHistory:true})).rejects.toThrow(/只读/);
  await expect(svc.update(boss,'finance-product-purchase-history',row.id,{purchasePrice:9})).rejects.toThrow(/只读/);
  await expect(svc.remove(boss,'finance-product-purchase-history',row.id,'伪造删除')).rejects.toThrow(/只读/);
  expect(await history(p.id,other)).toHaveLength(0);
  const reader={...boss,permissions:{isCompanyAdmin:false,allow:['resource.finance-products.view'],deny:['product.cost.view']}};
  const masked=(await history(p.id,reader))[0];expect(masked.data.purchasePrice).toBeUndefined();expect(masked.data.rawMaterialPurchasePrice).toBeUndefined();expect(masked.title).not.toContain('321');
 });
});
