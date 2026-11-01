import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';
import { CostService } from './cost.service';
import { CostVersionController } from './cost-version.controller';
import { PricingDebugService } from './pricing-debug.service';
import { DataToolsService } from './data-tools.service';

const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('成本版本完整生命周期（隔离 MySQL）',()=>{
  let ds:DataSource,svc:ResourcesService,cost:CostService,controller:CostVersionController,boss:AuthUser,other:AuthUser;
  let baseId:number,bundleId:number,productId:number,productCostId:number,bundleTitle:string;
  const code=()=>crypto.randomBytes(6).toString('hex');
  const createVersion=async()=>{
    const active=await svc.list(boss,'finance-cost-versions',{status:'active',showHidden:true,pageSize:200});
    for(const v of active.items)await svc.changeStatus(boss,'finance-cost-versions',v.id,'inactive','测试场景结束');
    return svc.create(boss,'finance-cost-versions',{versionCode:code(),versionName:'测试成本版本',defaultMarkupPercent:20,effectiveFrom:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})});
  };
  const createSku=(versionId:number)=>svc.create(boss,'finance-cost-skus',{versionId,skuType:'bundle',bundleId,purchaseCost:1000.1234,transferCost:0,preShipPackageCost:0,productionCost:0,estimatedExpressCost:200,shippingPackageCost:50});
  beforeAll(async()=>{
    ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME ?? 'kudesi_oa_test_a'}),migrationsRun:true} as never);await ds.initialize();
    svc=buildServices(ds).resources;cost=new CostService(ds);controller=new CostVersionController(ds,svc,cost);
    async function user(){const company=await ds.manager.save(Company,ds.manager.create(Company,{code:code(),name:'成本版本测试',status:'active'}));const u=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'admin',passwordHash:'x',name:'管理员',isCompanyAdmin:true,status:'active',mustChangePassword:false}));return {id:u.id,companyId:company.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};}
    boss=await user();other=await user();
    const root=await svc.create(boss,'finance-categories',{archiveType:'raw',name:'原料',code:'YL'});
    const category=await svc.create(boss,'finance-categories',{archiveType:'raw',name:'苹果',code:'PG',parentId:root.id});
    const product=await svc.create(boss,'finance-products',{archiveType:'raw',name:'红富士',categoryId:category.id,purchaseSpec:'千克',specQty:1,specUnit:'KG',purchasePrice:1000,freight:200,handlingFee:50});productId=product.id;
    productCostId=(await svc.create(boss,'finance-product-costs',{productId,costType:'purchase',unitCost:1000,unitName:'千克',effectiveFrom:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),sourceType:'manual'})).id;
    const base=await svc.create(boss,'finance-base-codes',{productId});baseId=base.id;await svc.changeStatus(boss,'finance-base-codes',base.id,'verified');
    const platform=await svc.create(boss,'finance-platforms',{code:'TB',name:'淘宝'}),scenario=await svc.create(boss,'finance-scenarios',{code:'LS',name:'零售',segment:'LS'});
    const bundleRoot=await svc.create(boss,'finance-categories',{archiveType:'bundle',name:'组合分类',code:'ZH'}),bundleCategory=await svc.create(boss,'finance-categories',{archiveType:'bundle',parentId:bundleRoot.id,name:'水果组合',code:'SG'});
    const bundle=await svc.create(boss,'finance-bundles',{platformId:platform.id,scenarioId:scenario.id,bundleCategoryId:bundleCategory.id});bundleId=bundle.id;
    await svc.create(boss,'finance-bundle-lines',{bundleId,role:'main',baseCodeId:baseId,qty:1});await svc.changeStatus(boss,'finance-bundles',bundleId,'verified');
    bundleTitle=(await svc.get(boss,'finance-bundles',bundleId)).title;
    await svc.create(boss,'finance-margins',{profitPercent:25,reason:'测试默认利润率'});
    await svc.create(boss,'finance-freight-overrides',{weightFrom:0.5,weightTo:1,amount:200,reason:'测试统一快递费'});
  });
  afterAll(async()=>{await ds?.destroy();});

  it('空版本与绕过预检直接启用均被拒绝，事务不留下激活状态',async()=>{
    const v=await createVersion();await expect(svc.changeStatus(boss,'finance-cost-versions',v.id,'active')).rejects.toThrow(/至少需要一条SKU/);
    await createSku(v.id);await expect(svc.changeStatus(boss,'finance-cost-versions',v.id,'active')).rejects.toThrow(/重新预检/);
    expect((await svc.get(boss,'finance-cost-versions',v.id)).status).toBe('draft');
  });
  it('预检后资料变化会拒绝启用；重新预检后保存锁定快照',async()=>{
    const v=await createVersion(),sku=await createSku(v.id),preview=await controller.preview(boss,v.id);
    expect(preview.ready).toBe(true);await svc.update(boss,'finance-cost-skus',sku.id,{purchaseCost:1100.1234});
    await expect(controller.activate(boss,v.id,{signature:preview.activationSignature})).rejects.toThrow(/重新预检/);
    expect((await svc.get(boss,'finance-cost-versions',v.id)).data.activationSignature).toBeUndefined();
    const fresh=await controller.preview(boss,v.id);await controller.activate(boss,v.id,{signature:fresh.activationSignature});
    expect((await svc.get(boss,'finance-cost-versions',v.id)).data.lockedAt).toBeTruthy();
    expect((await svc.get(boss,'finance-cost-skus',sku.id)).data.snapshot).toMatchObject({minPriceCents:1621});
    const noCost={...boss,permissions:{isCompanyAdmin:false,allow:['resource.finance-cost-versions.*'],deny:[]}};
    const hidden=(await svc.get(noCost,'finance-cost-skus',sku.id)).data;
    for(const field of ['purchaseCost','transferCost','preShipPackageCost','productionCost','shippingPackageCost','estimatedExpressCost','snapshot','markupPercent'])expect(hidden).not.toHaveProperty(field);
    expect((await svc.get(noCost,'finance-cost-versions',v.id)).data).not.toHaveProperty('defaultMarkupPercent');
  });
  it('启用后不能改成本、移动版本、停用SKU、删除，整类恢复也不能覆盖快照',async()=>{
    const v=await createVersion(),sku=await createSku(v.id),preview=await controller.preview(boss,v.id);await controller.activate(boss,v.id,{signature:preview.activationSignature});
    await expect(svc.update(boss,'finance-cost-skus',sku.id,{purchaseCost:1})).rejects.toThrow(/草稿/);
    await expect(svc.changeStatus(boss,'finance-cost-skus',sku.id,'inactive')).rejects.toThrow(/草稿/);
    await expect(svc.remove(boss,'finance-cost-skus',sku.id,'删除测试')).rejects.toThrow(/不能删除/);
    await expect(svc.update(boss,'finance-cost-versions',v.id,{defaultMarkupPercent:10})).rejects.toThrow(/锁定/);
    await expect(svc.restoreImportBackup(boss,'finance-cost-skus',1)).rejects.toThrow(/不支持整类/);
  });
  it('期间版本按业务日期返回锁定成本，SKU实时成本与定价调试保持现算链路',async()=>{
    const v=await createVersion();await createSku(v.id);const preview=await controller.preview(boss,v.id);await controller.activate(boss,v.id,{signature:preview.activationSignature});
    const day=String(v.data.effectiveFrom);
    expect((await controller.effective(boss,{businessDate:day})).rows.find(r=>r.skuType==='bundle')?.minPriceCents).toBe(1501);
    const before=await cost.one(boss,bundleId);expect(before.minPriceCents).toBe(1934);
    expect((await cost.verifiedFeed(boss.companyId)).find(r=>r.bundleId===bundleId)?.minPriceCents).toBe(before.minPriceCents);
    await svc.update(boss,'finance-products',productId,{purchasePrice:333});
    await svc.update(boss,'finance-product-costs',productCostId,{unitCost:333});
    expect((await controller.effective(boss,{businessDate:day})).rows.find(r=>r.skuType==='bundle')?.minPriceCents).toBe(1501);
    const current=await cost.one(boss,bundleId);expect(current.minPriceCents).toBe(1044);
    expect((await new PricingDebugService(cost).list(boss,{page:1,pageSize:30})).rows.find(r=>r.id===bundleId)?.minPriceCents).toBe(current.minPriceCents);
    const stopped=await svc.changeStatus(boss,'finance-cost-versions',v.id,'inactive','季节结束');expect(stopped.data.isDefault).toBe(false);
    expect((await svc.get(boss,'finance-cost-versions',v.id)).data.lockedAt).toBeTruthy();
    await expect(controller.effective(boss,{businessDate:day})).rejects.toThrow(/没有可用/);
  });
  it('复制版本完整重映射辅助类型、分摊和SKU引用，不复制锁定快照',async()=>{
    const v=await createVersion(),sku=await createSku(v.id);
    const kind=await svc.create(boss,'finance-cost-aux-types',{versionId:v.id,typeCode:'BZ',typeName:'打包',costBucket:'production',calculationMethod:'fixed_per_item'});
    const aux=await svc.create(boss,'finance-cost-auxiliary',{versionId:v.id,auxTypeId:kind.id,costName:'打包人工',costBucket:'production',amount:100});
    await svc.create(boss,'finance-cost-assignments',{versionId:v.id,skuSettingId:sku.id,auxiliaryId:aux.id,qty:2,mode:'add'});
    const recalc=await controller.recalculatePreview(boss,v.id);await controller.recalculate(boss,v.id,{signature:recalc.signature});
    const preview=await controller.preview(boss,v.id);await controller.activate(boss,v.id,{signature:preview.activationSignature});
    const copied=await controller.copy(boss,v.id,{versionCode:code(),versionName:'复制草稿'}),clone=await svc.get(boss,'finance-cost-versions',copied.id);
    expect(clone.status).toBe('draft');expect(clone.data.lockedAt).toBeUndefined();
    const rows=await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId}}),children=rows.filter(r=>r.data.versionId===copied.id),assignment=children.find(r=>r.type==='finance-cost-assignments')!;
    expect(assignment.data.skuSettingId).not.toBe(sku.id);expect(assignment.data.auxiliaryId).not.toBe(aux.id);expect(children.find(r=>r.type==='finance-cost-skus')!.data.snapshot).toBeUndefined();
    const clonePreview=await controller.preview(boss,copied.id);
    expect(clonePreview.rows.find(r=>r.skuType==='bundle')?.costIncludingFreightCents).toBe(preview.rows.find(r=>r.skuType==='bundle')?.costIncludingFreightCents);
    expect(clonePreview.rows.find(r=>r.skuType==='bundle')?.buckets.production).toBe(200);
  });
  it('预检补齐SKU、清空草稿在同一事务内完成，锁定版本不能清空',async()=>{
    const v=await createVersion(),sources=await controller.sources(boss,v.id);
    expect(sources.rows.some(r=>r.skuId===baseId && r.skuType==='base_code')).toBe(true);
    expect((await controller.register(boss,v.id,{signature:sources.signature})).created).toBe(sources.rows.length);
    const preview=await controller.preview(boss,v.id);
    const result=await controller.clear(boss,v.id,{signature:preview.signature,confirmCode:String(v.data.versionCode),reason:'清理草稿'});expect(result.deleted).toBe(sources.rows.length);
    expect((await controller.preview(boss,v.id)).rows).toEqual([]);
    await createSku(v.id);const fresh=await controller.preview(boss,v.id);await controller.activate(boss,v.id,{signature:fresh.activationSignature});
    await expect(controller.clear(boss,v.id,{signature:fresh.signature,confirmCode:String(v.data.versionCode),reason:'清理测试'})).rejects.toThrow(/只能清空草稿/);
  });
  it('引用与接口都按公司隔离，只有成本编辑权限能写，导入限定在所选版本',async()=>{
    const v=await createVersion();await expect(controller.preview(other,v.id)).rejects.toThrow(/不存在/);
    await expect(svc.create(other,'finance-cost-skus',{versionId:v.id,skuType:'bundle',bundleId})).rejects.toThrow();
    const viewer={...boss,permissions:{isCompanyAdmin:false,allow:['product.cost.view'],deny:[]}};
    await expect(svc.create(viewer,'finance-cost-versions',{versionCode:code(),versionName:'越权',defaultMarkupPercent:20})).rejects.toThrow();
    const imported=await svc.importRows(boss,'finance-cost-skus',[{'SKU类型':'商品组合编码','商品组合编码':bundleTitle,'采购成本':'1.123456','快递成本':'2'}],false,false,v.id);
    expect(imported.failed).toBe(0);expect(imported.committed).toBe(true);
    const row=(await svc.list(boss,'finance-cost-skus',{fieldKey:'versionId',fieldValue:String(v.id)})).items[0];expect(row.data.purchaseCost).toBe(112.3456);
    const updated=await svc.importRows(boss,'finance-cost-skus',[{'SKU类型':'商品组合编码','商品组合编码':bundleTitle,'采购成本':'2.123456'}],false,false,v.id);
    expect(updated.updated).toBe(1);expect(updated.created).toBe(0);expect(updated.failed).toBe(0);
    expect((await svc.get(boss,'finance-cost-skus',row.id)).data.purchaseCost).toBe(212.3456);
    expect((await svc.list(boss,'finance-cost-skus',{fieldKey:'versionId',fieldValue:String(v.id)})).total).toBe(1);
  });
  it('启用下一期间自动衔接原默认版本，日期重叠拒绝且可按日期取回旧快照',async()=>{
    const first=await createVersion();await createSku(first.id);
    await controller.activate(boss,first.id,{signature:(await controller.preview(boss,first.id)).activationSignature});
    const day=String(first.data.effectiveFrom),tomorrow=new Date(`${day}T00:00:00Z`);tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
    const nextDay=tomorrow.toISOString().slice(0,10);
    const next=await svc.create(boss,'finance-cost-versions',{versionName:'下一期',defaultMarkupPercent:20,effectiveFrom:nextDay});await createSku(next.id);
    const pre=await controller.preview(boss,next.id);expect(pre.transition).toMatchObject({id:first.id,effectiveTo:day});expect(pre.ready).toBe(true);
    await controller.activate(boss,next.id,{signature:pre.activationSignature});
    expect((await svc.get(boss,'finance-cost-versions',first.id)).data.effectiveTo).toBe(day);
    expect((await controller.effective(boss,{businessDate:day})).version.id).toBe(first.id);
    expect((await controller.effective(boss,{businessDate:nextDay})).version.id).toBe(next.id);
    const conflict=await svc.create(boss,'finance-cost-versions',{versionName:'重叠期',defaultMarkupPercent:20,effectiveFrom:day});await createSku(conflict.id);
    const blocked=await controller.preview(boss,conflict.id);expect(blocked.ready).toBe(false);expect(blocked.issues.join()).toMatch(/重叠/);
    await expect(controller.activate(boss,conflict.id,{signature:blocked.activationSignature})).rejects.toThrow(/重叠/);
    await expect(controller.effective(boss,{businessDate:'2026-02-30'})).rejects.toThrow(/日期无效/);
  });
  it('主数据重置和恢复不允许破坏成本版本引用',async()=>{
    const tools=new DataToolsService(ds,cost),pre=await tools.resetPreview(boss,true);expect(pre.blockedByCostVersions).toBeGreaterThan(0);
    await expect(tools.resetExecute(boss,{confirm:pre.confirmation,includePlatforms:true})).rejects.toThrow(/成本版本引用/);
  });
  it('公司尚无SKU成本时，全局生产标准的商品引用也能阻止主数据重置',async()=>{
    const category=await svc.create(other,'finance-categories',{archiveType:'raw',name:'其他公司原料',code:'YL'});
    const product=await svc.create(other,'finance-products',{archiveType:'raw',name:'其他公司商品',categoryId:category.id,purchaseSpec:'千克',specQty:1,specUnit:'KG',purchasePrice:100,freight:200,handlingFee:50});
    await svc.create(other,'finance-cost-production-rates',{rateCode:'SC-1',rateName:'指定商品生产',targetType:'product',productId:product.id,calculationMethod:'fixed_per_item',fixedAmount:10,priority:100});
    const tools=new DataToolsService(ds,cost),pre=await tools.resetPreview(other,true);
    expect(pre.blockedByCostVersions).toBeGreaterThan(0);
    await expect(tools.resetExecute(other,{confirm:pre.confirmation})).rejects.toThrow(/生产标准引用/);
  });
  it('等待公司锁之前读到旧草稿的事务，启用后仍不能修改或删除锁定SKU',async()=>{
    const v=await createVersion(),sku=await createSku(v.id),preview=await controller.preview(boss,v.id);
    const runner=ds.createQueryRunner();await runner.connect();await runner.startTransaction('REPEATABLE READ');
    try {
      await runner.manager.findOneByOrFail(ResourceRecord,{id:sku.id,companyId:boss.companyId});
      await controller.activate(boss,v.id,{signature:preview.activationSignature});
      await expect(svc.updateRecord(runner.manager,boss,'finance-cost-skus',sku.id,{purchaseCost:1})).rejects.toThrow(/已被其他操作修改/);
      await expect(svc.removeRecord(runner.manager,boss,'finance-cost-skus',sku.id,'并发删除测试')).rejects.toThrow(/已被其他操作修改/);
    } finally {await runner.rollbackTransaction();await runner.release();}
    expect((await svc.get(boss,'finance-cost-skus',sku.id)).data.snapshot).toBeTruthy();
  });
  it('草稿保存六科目成本，来源变化先比较差异再确认重算，保留人工特殊调整',async()=>{
    const v=await createVersion(),sku=await svc.create(boss,'finance-cost-skus',{versionId:v.id,skuType:'bundle',bundleId});
    const product=await svc.get(boss,'finance-products',productId),purchase=Number(product.data.purchasePrice);
    expect(sku.data.purchaseCost).toBe(purchase);expect(sku.data.transferCost).toBe(250);
    const override=await svc.create(boss,'finance-cost-overrides',{versionId:v.id,skuSettingId:sku.id,name:'人工补贴',costBucket:'production',amount:25,mode:'add'});
    const before=(await controller.preview(boss,v.id)).rows[0];
    await svc.update(boss,'finance-products',productId,{purchasePrice:purchase+111});
    await svc.update(boss,'finance-product-costs',productCostId,{unitCost:purchase+111});
    expect((await controller.preview(boss,v.id)).rows[0].costIncludingFreightCents).toBe(before.costIncludingFreightCents);
    const proposed=await controller.recalculatePreview(boss,v.id);expect(proposed.ready).toBe(true);
    expect(proposed.rows.find(r=>r.skuType==='bundle')?.proposed).toBe(purchase+111+250+200+25);
    await svc.update(boss,'finance-products',productId,{purchasePrice:purchase+222});
    await svc.update(boss,'finance-product-costs',productCostId,{unitCost:purchase+222});
    await expect(controller.recalculate(boss,v.id,{signature:proposed.signature})).rejects.toThrow(/重新预检差异/);
    const fresh=await controller.recalculatePreview(boss,v.id);const result=await controller.recalculate(boss,v.id,{signature:fresh.signature});
    expect(result.updated).toBe(1);expect(result.created).toBe(1);
    const current=(await controller.preview(boss,v.id)).rows.find(r=>r.skuType==='bundle')!;expect(current.costIncludingFreightCents).toBe(purchase+222+250+200+25);
    expect((await svc.get(boss,'finance-cost-overrides',override.id)).data.amount).toBe(25);
  });
});
