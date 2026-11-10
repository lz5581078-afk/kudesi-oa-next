/** 60 real SKU specifications: archive -> automatic base -> ops -> warehouse -> finance -> cost/debug. */
import 'reflect-metadata';
import {randomBytes, randomUUID} from 'crypto';
import {readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {DataSource} from 'typeorm';
import type {StepDef} from '@kudesi/shared';
import type {AuthUser} from '../common/auth.decorators';
import {buildDataSourceOptions} from '../database/data-source';
import {Company, FinanceCostSnapshot, FlowDefinition, OutboxJob, ResourceRecord, User} from '../entities';
import {buildServices} from '../test-support';
import {OutboxService} from '../outbox/outbox.service';
import {BundleToolsService} from '../resources/bundle-tools.service';
import {FinanceDocumentsService} from '../resources/finance-documents.service';
import {CostService} from '../resources/cost.service';
import {CostMaintainService} from '../resources/cost-maintain.service';
import {DataToolsService} from '../resources/data-tools.service';
import {PricingDebugService} from '../resources/pricing-debug.service';
import {FlowService} from './flow.service';
import {SkuApplyService} from './sku-apply.service';

const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
const families=['raw','original_purchase','supplier_oem'] as const;
const archiveGolden=JSON.parse(readFileSync(join(__dirname,'fixtures/sku-chain-reference24.json'),'utf8')) as {rows:Array<{family:string;n:number;archiveCode:string;skuMainCodes:Record<string,string>}>};
type Family=typeof families[number];
type Case={family:Family; n:number; productId:number; baseId:number; cost:number; weight:number; qty:number; giftQty:number; packageQty:number; labelQty:number; otherQty:number; laborQty:number};
suite('SKU全链路60规格矩阵（隔离MySQL、真实服务、无外部发送）',()=>{
 let ds:DataSource,svc:ReturnType<typeof buildServices>['resources'],flow:FlowService,sku:SkuApplyService,cost:CostService,debug:PricingDebugService;
 let boss:AuthUser,ops:AuthUser,wh:AuthUser,fin:AuthUser;
 const ids:Record<string,number>={},cases:Case[]=[],made=new Map<number,number[]>(),evidence:Record<string,unknown>[]=[];
 const step=(key:string,type:StepDef['type'],id?:number):StepDef=>({key,name:key,type,...(type==='submit'?{assignee:{source:'requester'}}:id?{assignee:{source:'employee',id}}:{})}) as StepDef;
 const baseFor=async(productId:number)=>(await svc.list(boss,'finance-base-codes',{fieldKey:'productId',fieldValue:String(productId),showHidden:true,pageSize:200})).items;
 // Independent integer ratio oracle: archived base quotes end at yuan4; SKU sums end at yuan6.
 const baseRound=(cents:number)=>Math.round((cents+Number.EPSILON)*100)/100;
 const skuSum=(terms:Array<[number,number]>)=>Number((terms.reduce((sum,[price,qty])=>sum+BigInt(Math.round(price*1e6))*BigInt(Math.round(qty*1e6)),0n)+50_000_000n)/100_000_000n)/10000;
 const expected=(c:Case)=>({cost:skuSum([[c.cost,c.qty],[10.5,c.giftQty],[30.25,c.packageQty],[10.5,c.labelQty],[10.5,c.otherQty],[12.3456,c.laborQty]]),weight:Math.round((c.weight*c.qty+50*c.giftQty+20*c.packageQty+50*c.labelQty+50*c.otherQty)*1e6)/1e6});
 const spec=(c:Case)=>({name:`${c.family}-${c.n}`,brandId:ids.brand,main:[{baseCodeId:c.baseId,qty:c.qty}],gift:c.giftQty?[{baseCodeId:ids.shippingBase,qty:c.giftQty}]:[]});
 const config=(c:Case)=>({lines:[...(c.packageQty?[{role:'package',baseCodeId:ids.packageBase,qty:c.packageQty}]:[]),{role:'label',baseCodeId:ids.shippingBase,qty:c.labelQty},...(c.otherQty?[{role:'other',baseCodeId:ids.shippingBase,qty:c.otherQty}]:[]),...(c.laborQty?[{role:'labor',laborId:ids.labor,qty:c.laborQty}]:[])],notRequired:{...(!c.packageQty?{package:'客户自备包装'}:{}),...(!c.otherQty?{other:'无其他材料'}:{}),...(!c.laborQty?{labor:'无需额外人工'}:{})}});
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test_sku_matrix'}),migrationsRun:true} as never).initialize();
  const services=buildServices(ds);svc=services.resources;
  const outbox=new OutboxService(ds,svc),bundles=new BundleToolsService(ds,svc,outbox);
  flow=new FlowService(ds,svc,new FinanceDocumentsService(ds),bundles,outbox,undefined,undefined,services.crypto);
  sku=new SkuApplyService(ds,flow,bundles);cost=new CostService(ds);debug=new PricingDebugService(cost);
  const company=await ds.manager.save(Company,ds.manager.create(Company,{code:'mx'+randomBytes(6).toString('hex'),name:'合成SKU60规格',status:'active'}));
  await ds.manager.insert(ResourceRecord, [
    { companyId: company.id, type: 'finance-margins', uniqueKey: 'all', title: '测试默认利润率', status: 'active', searchText: '', data: { scopeKey: 'all', profitPercent: 0 } },
    { companyId: company.id, type: 'finance-freight-estimates', uniqueKey: 'default', title: '测试完整运费', status: 'active', searchText: '', data: { parcelLimit: 30, rowsJson: JSON.stringify([{ start: 0, end: 30, method: 'provincial_majority_mean_plus_10_percent', manualAmount: 0 }]) } },
  ]);
  const actor=async(name:string,allow:string[]=[],admin=false):Promise<AuthUser>=>{const u=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:name,name,passwordHash:'x',status:'active',mustChangePassword:false,isCompanyAdmin:admin}));return{id:u.id,companyId:u.companyId,name,permissions:{isCompanyAdmin:admin,allow,deny:[]}};};
  boss=await actor('admin',[],true);ops=await actor('ops',['flow.apply.view','finance.pricing-debug.view']);wh=await actor('warehouse');fin=await actor('finance',['resource.finance-bundles.create','resource.finance-bundles.edit','product.cost.view','finance.bundle-sync.manage']);
  ids.brand=(await svc.create(boss,'finance-brands',{name:'测试牌',code:'CSP'})).id;
  for(const [family,code] of [['raw','YL'],['original_purchase','YZ'],['supplier_oem','OM'],['self_made','ZC'],['package','BZ'],['shipping_material','FH'],['oem_package','OP']] as const){const root=await svc.create(boss,'finance-categories',{archiveType:family,name:`合成${family}`,code});ids[family]=(await svc.create(boss,'finance-categories',{archiveType:family,name:'末级',code:code+'1',parentId:root.id})).id;}
  ids.bundleCategory=(await svc.create(boss,'finance-categories',{archiveType:'bundle',name:'合成申请组合',code:'MX'})).id;
  ids.tb=(await svc.create(boss,'finance-platforms',{code:'TB',name:'淘宝'})).id;ids.dy=(await svc.create(boss,'finance-platforms',{code:'DY',name:'抖音'})).id;
  ids.scenario=(await svc.create(boss,'finance-scenarios',{code:'standard',name:'标准',segment:''})).id;
  const common={specQty:1,specUnit:'PCS',purchaseSpec:'件',freight:0.25,handlingFee:0.25,weightManual:true};
  const packaging=await svc.create(boss,'finance-products',{...common,archiveType:'package',categoryId:ids.package,name:'测试包装',brandId:ids.brand,capacities:'500G',purchasePrice:29.75,weightG:20});
  const shipping=await svc.create(boss,'finance-products',{...common,archiveType:'shipping_material',categoryId:ids.shipping_material,name:'测试标签',purchasePrice:10,weightG:50,giftShortName:'礼品',giftCodeShortName:'LP'});
  const oemPack=await svc.create(boss,'finance-products',{...common,archiveType:'oem_package',categoryId:ids.oem_package,name:'测试OEM袋',brandId:ids.brand,capacities:'500G',purchasePrice:8,weightG:10});ids.oemPack=oemPack.id;
  for(const [key,p] of [['packageBase',packaging],['shippingBase',shipping]] as const){const rows=await baseFor(p.id);expect(rows).toHaveLength(1);ids[key]=rows[0].id;await svc.changeStatus(boss,'finance-base-codes',rows[0].id,'verified');}
  // Source family mapping intentionally does not auto-create codes for self-made/OEM package archives.
  const self=await svc.create(boss,'finance-products',{...common,archiveType:'self_made',categoryId:ids.self_made,name:'测试自产品',brandId:ids.brand,purchasePrice:10,weightG:100});ids.self=self.id;expect(await baseFor(self.id)).toHaveLength(0);expect(await baseFor(oemPack.id)).toHaveLength(0);
  const laborVersion=await svc.create(boss,'finance-labor-versions',{versionCode:'MX',versionName:'合成人工',effectiveFrom:'2026-01-01'}),lc=await svc.create(boss,'finance-labor-categories',{versionId:laborVersion.id,name:'装配'}),lt=await svc.create(boss,'finance-labor-work-types',{name:'装箱'}),lu=await svc.create(boss,'finance-labor-units',{name:'元/件'});
  ids.labor=(await svc.create(boss,'finance-labor-costs',{versionId:laborVersion.id,archiveCategoryId:lc.id,workTypeId:lt.id,unitId:lu.id,workName:'测试装箱',unitPrice:12.3456})).id;await svc.changeStatus(boss,'finance-labor-versions',laborVersion.id,'active');
  for(const family of families)for(let n=1;n<=20;n++){
   const archiveType=family==='raw'?'raw':'purchased',unit=['G','KG','J'][n%3],amount=[125,0.5,2.5][n%3],automatic=[125,500,1250][n%3],purchase=100+n+0.1234;
   const p=await svc.create(boss,'finance-products',{archiveType,...(family!=='raw'?{supplyMode:family,brandId:ids.brand}:{}),categoryId:ids[family],name:`${family==='raw'?'R':family==='original_purchase'?'O':'M'}${n}`,specQty:amount,specUnit:unit,purchaseSpec:family==='raw'?`${amount}${['克','千克','斤'][n%3]}`:'件',purchasePrice:purchase,freight:0.123456,handlingFee:0.000001,...(family==='original_purchase'?{weightManual:true,weightG:automatic+7}:{})});
   if(family==='supplier_oem')await svc.create(boss,'finance-product-boms',{productId:p.id,componentId:oemPack.id,qty:2.5});
   const current=await svc.get(boss,'finance-products',p.id),rows=await baseFor(p.id);expect(rows).toHaveLength(1);const bc=rows[0];
   const expectedCost=baseRound(purchase+0.123457+(family==='supplier_oem'?8*2.5:0));
   expect(bc.data.cost).toBe(expectedCost);expect(bc.data.code).toBe(current.data.code);expect(bc.data.origin).toBe('archive_sync');
   expect(current.data.code).toBe(archiveGolden.rows.find(row=>row.family===family&&row.n===n)!.archiveCode);
   const expectedWeight=family==='raw'?automatic:family==='supplier_oem'?automatic+25:automatic+7;expect(current.data.weightG).toBe(expectedWeight);
   await svc.changeStatus(boss,'finance-base-codes',bc.id,'verified');
   cases.push({family,n,productId:p.id,baseId:bc.id,cost:expectedCost,weight:expectedWeight,qty:n,giftQty:n%4,packageQty:n%5===0?0:n%2?1:0.123456,labelQty:1+n%3,otherQty:n%2?0:0.000001,laborQty:n%3===0?0:n%2?1.25:0.123456});
  }
  await flow.saveDraft(boss,'sku-batch-apply',[step('apply','submit'),step('warehouse','execute',wh.id),step('review','finance',fin.id),step('end','end')],[]);await flow.publish(boss,'sku-batch-apply');ids.definition=(await ds.manager.findOneByOrFail(FlowDefinition,{companyId:boss.companyId,templateKey:'sku-batch-apply',status:'active'})).id;
 },120000);
 afterAll(async()=>{if(process.env.SKU_CHAIN_REPORT)writeFileSync(process.env.SKU_CHAIN_REPORT,JSON.stringify({specifications:cases.length,generated:evidence.length,cases:evidence},null,2)+'\n');await ds?.destroy();});

 it.each(Array.from({length:6},(_,i)=>i))('批次 %i：10规格×2平台，核对每条最终编码/重量/成本与两个下游表',async(batch)=>{
  const selected=cases.slice(batch*10,batch*10+10);
  const application=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:ids.definition,confirmations:{referenceSearched:true},requestKey:randomUUID(),payloads:selected.map(c=>({batchName:`矩阵${batch}`,scenarioId:ids.scenario,platformIds:[ids.tb,ids.dy],bundleCategoryId:ids.bundleCategory,specs:[spec(c)]}))});
  expect(application.runs).toHaveLength(10);
  for(const [index,c] of selected.entries()){
   const draft=application.runs[index];await flow.submitApplicationDraft(ops,draft.id,draft.revision,randomUUID());const run=await flow.detail(wh,draft.id);
   expect(run.activeStep?.key).toBe('warehouse');
   await expect(flow.pass(ops,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:{config:[config(c)]}})).rejects.toThrow(/不是你办理/);
   const review=await flow.pass(wh,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:{config:[config(c)]}});
   const preview=await sku.preview(fin,run.id,review.revision),value=expected(c);expect(preview.specs).toHaveLength(1);expect(preview.specs[0].totalCost).toBe(value.cost);expect(preview.specs[0].weightG).toBe(value.weight);expect(preview.specs[0].targets).toHaveLength(2);
   const done=await flow.pass(fin,run.id,{revision:review.revision,stepId:review.activeStep!.id,form:{confirmed:true}});expect(done.status).toBe('completed');
   const output=await sku.preview(fin,run.id),idsForCase=output.specs[0].created.map(x=>x.bundleId);expect(idsForCase).toHaveLength(2);made.set(c.baseId,idsForCase);
   for(const id of idsForCase){const b=await svc.get(boss,'finance-bundles',id);expect(b.status).toBe('verified');expect(b.data.sourceRunId).toBe(run.id);expect(b.data.code).toBe(preview.specs[0].targets.find(t=>t.platformId===b.data.platformId)!.code);expect(String(b.data.code)).toMatch(/^ZH-(TB|DY)-/);expect(String(b.data.code).length).toBeLessThanOrEqual(48);const platform=b.data.platformId===ids.tb?'TB':'DY',golden=archiveGolden.rows.find(row=>row.family===c.family&&row.n===c.n)!;expect(b.data.code).toBe(golden.skuMainCodes[platform]+(c.giftQty?`+ZP-LP*${c.giftQty}`:''));
    const history=await ds.manager.find(FinanceCostSnapshot,{where:{companyId:boss.companyId,bundleId:id}});expect(history).toHaveLength(1);expect(Number(history[0].preShipCostCents)).toBe(value.cost);expect(Number(history[0].weightG)).toBe(value.weight);
    evidence.push({family:c.family,n:c.n,platform,archiveCode:golden.archiveCode,skuCode:b.data.code,qty:c.qty,giftQty:c.giftQty,packageQty:c.packageQty,labelQty:c.labelQty,otherQty:c.otherQty,laborQty:c.laborQty,expectedCostCents:value.cost,actualCostCents:Number(history[0].preShipCostCents),expectedWeightG:value.weight,actualWeightG:Number(history[0].weightG)});
   }
  }
  const table=await cost.table(boss,{page:1,pageSize:200}),pricing=await debug.list(boss,{page:1,pageSize:200});
  for(const c of selected)for(const id of made.get(c.baseId)!){const value=expected(c);expect(table.rows.find(row=>row.bundleId===id)).toMatchObject({preShipCostCents:value.cost,weightG:value.weight});expect(pricing.rows.find(row=>row.id===id)).toMatchObject({preShipCostCents:value.cost,weightG:value.weight});}
  const hidden=await debug.list(ops,{page:1,pageSize:200});expect(hidden.rows.every(row=>!('preShipCostCents'in row))).toBe(true);const jobs=await ds.manager.find(OutboxJob,{where:{companyId:boss.companyId}});expect(jobs).toHaveLength((batch+1)*20);expect(jobs.every(job=>job.status==='failed'&&job.attempts===0&&job.payloadJson.blockedIntent===true)).toBe(true);
 },120000);

 it('仓库包装目录与服务端均排除OEM包装；原OEM上游BOM成本功能保留',async()=>{
  const oem=await svc.create(boss,'finance-base-codes',{productId:ids.oemPack,code:'OEM-PACK-SCOPE',codeChangeReason:'合成范围核对'});await svc.changeStatus(boss,'finance-base-codes',oem.id,'verified');
  const c={...cases[1],qty:99},application=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:ids.definition,confirmations:{referenceSearched:true},requestKey:randomUUID(),payloads:[{batchName:'包装来源范围',scenarioId:ids.scenario,platformIds:[ids.tb],bundleCategoryId:ids.bundleCategory,specs:[spec(c)]}]});
  const draft=application.runs[0];await flow.submitApplicationDraft(ops,draft.id,draft.revision,randomUUID());const run=await flow.detail(wh,draft.id);
  const catalog=await sku.catalogOptions(wh,'package',{runId:run.id,page:1,pageSize:200});expect(catalog.items.map(row=>row.id)).toContain(ids.packageBase);
  const ordinary=await sku.options(wh,'package','','',{runId:run.id});expect(ordinary.items?.some(row=>row.id===oem.id)).toBe(false);
  const bad={lines:[{role:'package',baseCodeId:oem.id,qty:1}],notRequired:{label:'无标签',other:'无打包材料',labor:'无人工'}};
  const accepted=await flow.pass(wh,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:{config:[bad]}}).then(()=>true,error=>{expect(error.message).toMatch(/不能当作包装/);return false;});expect({listed:catalog.items.some(row=>row.id===oem.id),accepted}).toEqual({listed:false,accepted:false});expect((await flow.detail(wh,run.id)).activeStep?.key).toBe('warehouse');
  const source=cases.find(row=>row.family==='supplier_oem')!;expect((await svc.get(boss,'finance-products',source.productId)).data).toMatchObject({weightG:source.weight,totalCost:121.246857});
  const main=await sku.catalogOptions(ops,'main',{page:1,pageSize:200}),gift=await sku.catalogOptions(ops,'gift',{page:1,pageSize:200});expect(main.total).toBe(60);expect(main.items.some(row=>[ids.packageBase,ids.shippingBase,oem.id].includes(row.id))).toBe(false);expect(gift.items.some(row=>row.id===ids.shippingBase)).toBe(true);expect(gift.items.some(row=>[ids.packageBase,oem.id].includes(row.id))).toBe(false);
 });

 it('默认命名相同但实际商品不同，拦截编码碰撞且不覆盖旧SKU和成本',async()=>{
  const p=await svc.create(boss,'finance-products',{archiveType:'purchased',supplyMode:'original_purchase',categoryId:ids.original_purchase,brandId:ids.brand,name:'R1',specQty:0.5,specUnit:'KG',purchaseSpec:'件',purchasePrice:50,freight:1,handlingFee:1});const base=(await baseFor(p.id))[0];await svc.changeStatus(boss,'finance-base-codes',base.id,'verified');
  const c={...cases[0],baseId:base.id},application=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:ids.definition,confirmations:{referenceSearched:true},requestKey:randomUUID(),payloads:[{batchName:'编码碰撞',scenarioId:ids.scenario,platformIds:[ids.tb],bundleCategoryId:ids.bundleCategory,specs:[spec(c)]}]});const draft=application.runs[0];await flow.submitApplicationDraft(ops,draft.id,draft.revision,randomUUID());const run=await flow.detail(wh,draft.id),before=await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId,type:'finance-bundles'},order:{id:'ASC'}});
  await expect(flow.pass(wh,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:{config:[config(c)]}})).rejects.toThrow(/编码.*占用/);expect(await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId,type:'finance-bundles'},order:{id:'ASC'}})).toEqual(before);
 });

 it('三个主品分类售价设置后调试表就绪，低价、滑块和ROI读取同一成本；运营不泄成本',async()=>{
  const maintain=new CostMaintainService(ds,svc,new DataToolsService(ds,cost));
  for(const family of families){const c=cases.find(row=>row.family===family)!,id=made.get(c.baseId)![0];await svc.update(boss,'finance-bundles',id,{manualFreight:800,overrideReason:'合成固定运费'});let row=await cost.one(boss,id);await maintain.savePricing(boss,id,{revision:row.revision,carrierName:'合成快递',profitPercent:17.123456,reason:'合成跨分类售价联动'});row=await cost.one(boss,id);
   const numerator=(BigInt(Math.round(expected(c).cost*10000))+8000000n)*100000000n,denominator=82876544n*10000n,floor=Number((numerator+denominator-1n)/denominator);expect(row.minPriceCents).toBe(floor);const list=await debug.list(boss,{page:1,pageSize:200});expect(list.rows.find(r=>r.id===id)).toMatchObject({ready:true,minPriceCents:floor,preShipCostCents:expected(c).cost});
   const price=await debug.sliderPrice(boss,{id,step:10});expect(price.priceCents).toBe(Math.ceil(floor*1.1));const quote=await debug.quote(boss,'roiToPrice',[{id,step:10,value:4}]);expect(quote.rows[0]).toMatchObject({available:true,priceCents:Math.ceil(price.priceCents!*4/3)});const hidden=await debug.list(ops,{page:1,pageSize:200});expect(hidden.rows.find(r=>r.id===id)).not.toHaveProperty('preShipCostCents');
  }
 });

 it('自制品BOM独立核对材料、损耗、包装和人工；仓库/运营不能改商品成本',async()=>{
  const raw=cases[0],product=await svc.get(boss,'finance-products',ids.self);await svc.update(boss,'finance-products',ids.self,{weightManual:false});
  await svc.create(boss,'finance-product-boms',{productId:ids.self,componentId:raw.productId,qty:0.5,lossPercent:10});await svc.create(boss,'finance-product-boms',{productId:ids.self,componentId:(await svc.get(boss,'finance-base-codes',ids.packageBase)).data.productId,qty:0.25});await svc.create(boss,'finance-product-boms',{productId:ids.self,laborId:ids.labor,qty:1.25});
  const result=await svc.get(boss,'finance-products',ids.self);expect(result.data.totalCost).toBe(79.180271);expect(result.data.weightG).toBe(255);expect(await baseFor(ids.self)).toHaveLength(0);expect(product.id).toBe(ids.self);
  const before=(await svc.get(boss,'finance-products',raw.productId)).data.purchasePrice;
  for(const user of [ops,wh]){const hidden=await svc.update(user,'finance-products',raw.productId,{purchasePrice:999});expect(hidden.data).not.toHaveProperty('purchasePrice');expect((await svc.get(boss,'finance-products',raw.productId)).data.purchasePrice).toBe(before);}
 });

 it('资料变更联动成本与重量；商品/基础/已上传SKU编码和历史身份保持不变',async()=>{
  const c=cases[0],bundleIds=made.get(c.baseId)!;expect(bundleIds).toHaveLength(2);
  const before=await ds.manager.find(FinanceCostSnapshot,{where:{companyId:boss.companyId,bundleId:bundleIds[0]},order:{id:'ASC'}});
  const product=await svc.get(boss,'finance-products',c.productId);
  const identities=new Map<number,Record<string,unknown>>();for(const id of [c.baseId,...bundleIds]){const stored=await ds.manager.findOneByOrFail(ResourceRecord,{id,companyId:boss.companyId});stored.data={...stored.data,jstUploadedCode:stored.data.code};await ds.manager.save(ResourceRecord,stored);identities.set(id,{code:stored.data.code,jstUploadedCode:stored.data.code});}
  await svc.update(boss,'finance-products',c.productId,{code:'MATRIX-UPDATED',purchasePrice:200,name:'RENAMED',specQty:250,specUnit:'G',weightManual:true,weightG:777});
  const base=await svc.get(boss,'finance-base-codes',c.baseId);expect(base.status).toBe('reverify');expect(base.data).toMatchObject({...identities.get(c.baseId),cost:200.12,weightG:777,varietyName:'RENAMED',spec:'250G'});expect(await baseFor(c.productId)).toHaveLength(1);
  const table=await cost.table(boss,{page:1,pageSize:200}),pricing=await debug.list(boss,{page:1,pageSize:200});
  const updated=expected({...c,cost:200.12,weight:777});
  expect((await svc.get(boss,'finance-products',c.productId)).data.code).toBe('MATRIX-UPDATED');
  for(const id of bundleIds){const skuRow=await svc.get(boss,'finance-bundles',id);expect(skuRow.data).toMatchObject(identities.get(id)!);expect(skuRow.status).toBe('reverify');expect(table.rows.find(r=>r.bundleId===id)).toMatchObject({preShipCostCents:updated.cost,weightG:updated.weight});expect(pricing.rows.find(r=>r.id===id)).toMatchObject({preShipCostCents:updated.cost,weightG:updated.weight});}
  expect(await ds.manager.findOneByOrFail(FinanceCostSnapshot,{id:before[0].id,companyId:boss.companyId})).toEqual(before[0]);expect(product.data.code).not.toBe('MATRIX-UPDATED');
  const target=bundleIds[0];
  for(const values of [{code:'WRONG-SKU'},{manualCode:'WRONG-SKU',manualReason:'有原因也不能改身份'}])await expect(svc.update(boss,'finance-bundles',target,values)).rejects.toThrow(/固定/);
  await svc.update(boss,'finance-bundles',target,{manualStyleCode:'AFTER-UPLOAD-STYLE',manualName:'上传后可维护名称',manualReason:'维护其他资料'});
  expect((await svc.get(boss,'finance-bundles',target)).data).toMatchObject({code:identities.get(target)!.code,styleCode:'AFTER-UPLOAD-STYLE',name:'上传后可维护名称'});
  await svc.changeStatus(boss,'finance-bundles',target,'pending');
  expect((await svc.get(boss,'finance-bundles',target)).data._financeCodeUploaded).toBe(true);
  await expect(svc.update(boss,'finance-bundles',target,{_financeCodeUploaded:false})).rejects.toThrow();
  await expect(ds.transaction(em=>svc.patchData(em,boss,'finance-bundles',target,{code:'INTERNAL-RECODE'}))).rejects.toThrow(/固定/);
  expect((await svc.get(boss,'finance-bundles',target)).data).toMatchObject(identities.get(target)!);
 });
});
