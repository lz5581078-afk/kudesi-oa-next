import 'reflect-metadata';
import {randomBytes} from 'crypto';
import {DataSource} from 'typeorm';
import {todayInChina} from '@kudesi/shared';
import type {AuthUser} from '../common/auth.decorators';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,ResourceRecord,User,Position} from '../entities';
import {buildServices} from '../test-support';
import {refreshDerivedArchiveCostRecords} from './product-costs';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('档案成本派生台账与主档计算分离（真实MySQL）',()=>{
 let ds:DataSource,svc:ReturnType<typeof buildServices>['resources'],user:AuthUser,raw:number,owner:number,costId:number,bomId:number;
 const key=()=>randomBytes(5).toString('hex'),day=todayInChina();
 const row=(id:number)=>ds.manager.findOneByOrFail(ResourceRecord,{id,companyId:user.companyId});
 const ledger=async(id=owner)=>(await ds.manager.find(ResourceRecord,{where:{companyId:user.companyId,type:'finance-product-costs'}})).filter(r=>r.data.productId===id&&r.data.costType==='purchase'&&r.status==='active'&&String(r.data.effectiveFrom)<=day&&(!r.data.effectiveTo||String(r.data.effectiveTo)>=day))[0];
 beforeAll(async()=>{ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never);await ds.initialize();svc=buildServices(ds).resources;});
 afterAll(async()=>{await ds?.destroy();});
 beforeEach(async()=>{
  const c=await ds.manager.save(Company,ds.manager.create(Company,{code:key(),name:'合成派生成本公司',status:'active'})),u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'admin',passwordHash:'x',name:'合成管理员',isCompanyAdmin:true,status:'active',mustChangePassword:false}));user={id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
  const root=await svc.create(user,'finance-categories',{archiveType:'raw',name:'原料',code:'YL'}),leaf=await svc.create(user,'finance-categories',{archiveType:'raw',name:'苹果',code:'PG',parentId:root.id}),made=await svc.create(user,'finance-categories',{archiveType:'self_made',name:'自产',code:'ZC'}),brand=await svc.create(user,'finance-brands',{name:'合成品牌',code:'HC'});
  raw=(await svc.create(user,'finance-products',{archiveType:'raw',name:'成本分离苹果',categoryId:leaf.id,purchaseSpec:'千克',specQty:1,specUnit:'KG',purchasePrice:1000,freight:200,handlingFee:50})).id;
  costId=(await svc.create(user,'finance-product-costs',{productId:raw,costType:'purchase',unitCost:1500,effectiveFrom:day})).id;
  owner=(await svc.create(user,'finance-products',{archiveType:'self_made',name:'成本分离自产',categoryId:made.id,brandId:brand.id,specQty:1,specUnit:'BOX'})).id;
  bomId=(await svc.create(user,'finance-product-boms',{productId:owner,componentId:raw,qty:1})).id;
 });
 it('保存采购价fallback1000、ledger1500和独立物流250；改ledger不写主档价格/总成本/重量',async()=>{
  expect((await row(bomId)).data.archiveBomCostSnapshot).toMatchObject({version:1,componentId:raw,unitCost:1000,freight:200,handlingFee:50});
  expect((await row(owner)).data.totalCost).toBe(1250);expect((await ledger()).data.unitCost).toBe(1750);
  const before=await row(owner),rawBefore=await row(raw);
  await svc.update(user,'finance-product-costs',costId,{unitCost:1600.1234});
  expect((await ledger()).data.unitCost).toBe(1850.12);
  for(const id of [owner,raw]){const old=id===owner?before:rawBefore,current=await row(id);for(const k of ['purchasePrice','totalCost','weightG'])expect(current.data[k]).toEqual(old.data[k]);}
  expect((await row(bomId)).data.archiveBomCostSnapshot).toMatchObject({unitCost:1000});
  expect((await svc.get(user,'finance-product-boms',bomId)).data.archiveBomCostSnapshot).toBeUndefined();
 });
 it('删除唯一ledger回退已保存采购价；旧缺事实不以live价格回填',async()=>{
  await svc.remove(user,'finance-product-costs',costId,'合成删除');expect((await ledger()).data.unitCost).toBe(1250);
  const b=await row(bomId);delete b.data.archiveBomCostSnapshot;await ds.manager.save(b);
  const before=(await ledger()).data.unitCost;
  const result=await ds.transaction(em=>refreshDerivedArchiveCostRecords(svc,em,user,{ownerProductIds:[owner]}));expect(result.missing).toContain(owner);expect((await ledger()).data.unitCost).toBe(before);expect((await row(bomId)).data.archiveBomCostSnapshot).toBeUndefined();
  await ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;await svc.updateRecord(em,user,'finance-product-boms',bomId,{qty:2});});expect((await row(bomId)).data.archiveBomCostSnapshot).toBeUndefined();
 });
 it('人工锁定和当天其他来源不覆盖，无关联档案不修改',async()=>{
  const target=await ledger();await svc.update(user,'finance-product-costs',target.id,{manualOverride:true,manualLockReason:'保留人工定价'});
  await svc.update(user,'finance-product-costs',costId,{unitCost:1700});expect((await ledger()).data.unitCost).toBe(1750);
  await svc.update(user,'finance-product-costs',target.id,{manualOverride:false,sourceType:'manual'});
  await svc.update(user,'finance-product-costs',costId,{unitCost:1800});expect((await ledger()).data.unitCost).toBe(1750);
  const before=await row(owner);await ds.transaction(em=>refreshDerivedArchiveCostRecords(svc,em,user,{componentProductIds:[999999999]}));expect((await row(owner)).data).toEqual(before.data);
 });
 it('业务日用当日有效成本，未来记录不提前改变今天；同事务故障完整回滚',async()=>{
  const future='2099-01-01';await svc.create(user,'finance-product-costs',{productId:raw,costType:'production',unitCost:300,effectiveFrom:future});
  expect((await ledger()).data.unitCost).toBe(1750);
  const futureRows=(await ds.manager.find(ResourceRecord,{where:{companyId:user.companyId,type:'finance-product-costs'}})).filter(r=>r.data.productId===owner&&r.data.effectiveFrom===future);expect(futureRows[0].data.unitCost).toBe(2050);
  const before=(await row(costId)).data,ownerBefore=(await ledger()).data;
  await expect(ds.transaction(async em=>{await svc.updateRecord(em,user,'finance-product-costs',costId,{unitCost:999.1234});expect((await em.findOneByOrFail(ResourceRecord,{id:(await ledger()).id})).data.unitCost).toBe(1249.12);throw Error('合成回滚');})).rejects.toThrow('合成回滚');
  expect((await row(costId)).data).toEqual(before);expect((await ledger()).data).toEqual(ownerBefore);
 });
 it('普通输入不能伪造保存价格，跨公司BOM也不能引用',async()=>{
  try{await svc.update(user,'finance-product-boms',bomId,{archiveBomCostSnapshot:{version:1,componentId:raw,unitCost:999999,freight:0,handlingFee:0}});}catch{}
  expect((await row(bomId)).data.archiveBomCostSnapshot).toMatchObject({unitCost:1000,freight:200,handlingFee:50});
  await expect(svc.create({...user,companyId:user.companyId+999999},'finance-product-boms',{productId:owner,componentId:raw,qty:1})).rejects.toThrow();
 });
 it('人工只用本次BOM保存价格，不以日后live价格或旧缺失事实冒充过去',async()=>{
  const v=await svc.create(user,'finance-labor-versions',{versionCode:'SYN',versionName:'合成保存人工版本'}),category=await svc.create(user,'finance-labor-categories',{versionId:v.id,name:'合成归档'}),work=await svc.create(user,'finance-labor-work-types',{name:'合成装袋'}),unit=await svc.create(user,'finance-labor-units',{name:'元/件'});
  const labor=await svc.create(user,'finance-labor-costs',{versionId:v.id,archiveCategoryId:category.id,workTypeId:work.id,unitId:unit.id,workName:'合成装箱',unitPrice:100});await svc.changeStatus(user,'finance-labor-versions',v.id,'active');
  const line=await svc.create(user,'finance-product-boms',{productId:owner,laborId:labor.id,qty:2});expect((await row(line.id)).data.archiveBomCostSnapshot).toMatchObject({laborId:labor.id,unitCost:100});expect((await ledger()).data.unitCost).toBe(1950);
  await svc.update(user,'finance-labor-costs',labor.id,{unitPrice:900});await svc.update(user,'finance-product-costs',costId,{unitCost:1800});expect((await ledger()).data.unitCost).toBe(2250);
  const old=await row(line.id);delete old.data.archiveBomCostSnapshot;await ds.manager.save(old);await svc.update(user,'finance-product-costs',costId,{unitCost:1900});expect((await ledger()).data.unitCost).toBe(2250);expect((await row(line.id)).data.archiveBomCostSnapshot).toBeUndefined();
 });
 it('无成本权限 get/list/logs 不泄露内部保存金额事实',async()=>{
  const viewer:AuthUser={...user,permissions:{isCompanyAdmin:false,allow:['finance.products.view'],deny:['product.cost.view','product.cost.edit']}};
  for(const result of [await svc.get(viewer,'finance-product-boms',bomId),await svc.list(viewer,'finance-product-boms',{fieldKey:'productId',fieldValue:String(owner)}),await svc.logs(viewer,'finance-product-boms',bomId)])expect(JSON.stringify(result)).not.toContain('archiveBomCostSnapshot');
 });

 it('真实DTO仅有权非仓库投影bomCostFacts，缺cost/仓库实际岗位/跨公司/旧无marker不透出',async()=>{
  const visible=await svc.get(user,'finance-product-boms',bomId);expect(visible.bomCostFacts).toEqual({unitCost:1000,freight:200,handlingFee:50});expect(visible.data.archiveBomCostSnapshot).toBeUndefined();expect((await svc.list(user,'finance-product-boms',{fieldKey:'productId',fieldValue:String(owner)})).items[0].bomCostFacts).toEqual(visible.bomCostFacts);
  const noCost:AuthUser={...user,permissions:{isCompanyAdmin:false,allow:['resource.finance-products.view'],deny:['product.cost.view']}};expect(await svc.get(noCost,'finance-product-boms',bomId)).not.toHaveProperty('bomCostFacts');
  const position=await ds.manager.save(Position,ds.manager.create(Position,{companyId:user.companyId,name:'合成真实仓库岗位',workspaceType:'warehouse'})),person=await ds.manager.save(User,ds.manager.create(User,{companyId:user.companyId,account:key(),name:'合成仓库查看人',passwordHash:'x',isCompanyAdmin:false,status:'active',positionId:position.id,mustChangePassword:false}));
  const warehouse:AuthUser={id:person.id,companyId:user.companyId,name:person.name,permissions:{isCompanyAdmin:false,allow:['resource.finance-products.view','product.cost.view'],deny:[]}};expect(await svc.get(warehouse,'finance-product-boms',bomId)).not.toHaveProperty('bomCostFacts');expect((await svc.list(warehouse,'finance-product-boms',{fieldKey:'productId',fieldValue:String(owner)})).items[0]).not.toHaveProperty('bomCostFacts');
  await expect(svc.get({...user,companyId:user.companyId+999999},'finance-product-boms',bomId)).rejects.toThrow();const old=await row(bomId);delete old.data.archiveBomCostSnapshot;await ds.manager.save(old);expect(await svc.get(user,'finance-product-boms',bomId)).not.toHaveProperty('bomCostFacts');
 });

 it('eight decimal BOM captures fees without changing old snapshots; parent and source-ledger have explicit distinct endpoints',async()=>{
  const oldSnapshot=structuredClone((await row(bomId)).data.archiveBomCostSnapshot);
  await svc.update(user,'finance-products',raw,{purchasePrice:100,freight:12.345678,handlingFee:12.345678});expect((await row(raw)).data.totalCost).toBe(124.691356);expect((await row(bomId)).data.archiveBomCostSnapshot).toEqual(oldSnapshot);
  await svc.update(user,'finance-product-boms',bomId,{qty:0.123456});
  expect((await row(bomId)).data.archiveBomCostSnapshot).toMatchObject({unitCost:100,freight:12.345678,handlingFee:12.345678});expect((await row(owner)).data.totalCost).toBe(15.393896);expect((await ledger()).data.unitCost).toBe(188.23);
  const parent=(await row(owner)).data,snapshot=(await row(bomId)).data.archiveBomCostSnapshot;await expect(ds.transaction(async em=>{await svc.updateRecord(em,user,'finance-product-boms',bomId,{qty:0.654321});throw Error('eight decimal BOM rollback');})).rejects.toThrow('eight decimal BOM rollback');expect((await row(owner)).data).toEqual(parent);expect((await row(bomId)).data.archiveBomCostSnapshot).toEqual(snapshot);
 });

});
