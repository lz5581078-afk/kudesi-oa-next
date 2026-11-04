import 'reflect-metadata';
import {randomBytes,randomUUID} from 'crypto';
import {DataSource} from 'typeorm';
import {sourceProductImportProfile} from '@kudesi/shared';
import {Company,ResourceRecord,User} from '../entities';
import type {AuthUser} from '../common/auth.decorators';
import {buildDataSourceOptions} from '../database/data-source';
import {buildServices} from '../test-support';
import {CostService} from './cost.service';
const db=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
db('档案运费装卸费八位元真实存取边界',()=>{
 let ds:DataSource,svc:ReturnType<typeof buildServices>['resources'],user:AuthUser,categoryId:number,brandId:number;
 const values=(name:string)=>({archiveType:'purchased',supplyMode:'original_purchase',name,categoryId,brandId,specQty:1,specUnit:'KG',purchaseSpec:'千克',purchasePrice:100,freight:12.345678,handlingFee:12.345678});
 beforeAll(async()=>{ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();svc=buildServices(ds).resources;});
 afterAll(async()=>{await ds?.destroy();});
 beforeEach(async()=>{const company=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'合成八位物流公司',status:'active'})),person=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'synthetic',passwordHash:'unused',name:'合成管理员',isCompanyAdmin:true,status:'active',mustChangePassword:false}));user={id:person.id,companyId:company.id,name:person.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};categoryId=(await svc.create(user,'finance-categories',{archiveType:'original_purchase',name:'合成采购目录',code:'HC'})).id;brandId=(await svc.create(user,'finance-brands',{name:'合成品牌',code:'HC'})).id;await svc.create(user,'finance-product-units',{kind:'archive_unit',name:'千克',code:'KG'});});
 it('录入GET/复制保留两费和混合总额，新增物流历史保留八位且旧快照不改',async()=>{
  const original=await svc.create(user,'finance-products',values('合成八位采购'));
  const get=await svc.get(user,'finance-products',original.id);expect(get.data).toMatchObject({freight:12.345678,handlingFee:12.345678,totalCost:124.691356,purchasePrice:100});
  const history=(await svc.list(user,'finance-product-freight-history',{fieldKey:'productId',fieldValue:String(original.id)})).items;expect(history).toHaveLength(1);expect(history[0].data).toMatchObject({freight:12.345678,handlingFee:12.345678});
  const copy=await svc.saveForm(user,'finance-products',{requestKey:randomUUID(),copySource:{id:get.id,version:get.version!,files:{}},values:values('合成八位采购副本'),collections:[]});expect(copy.data).toMatchObject({freight:12.345678,handlingFee:12.345678,totalCost:124.691356});
  await svc.update(user,'finance-products',original.id,{freight:12.345679});expect((await svc.get(user,'finance-products',original.id)).data.totalCost).toBe(124.691357);expect((await svc.get(user,'finance-product-freight-history',history[0].id)).data).toEqual(history[0].data);
  const noCost:AuthUser={...user,permissions:{isCompanyAdmin:false,allow:['resource.finance-products.view'],deny:['product.cost.view']}};expect((await svc.get(noCost,'finance-products',original.id)).data).not.toHaveProperty('freight');await expect(svc.get({...user,companyId:user.companyId+999999},'finance-products',original.id)).rejects.toThrow();
 });
 it('真实源文件预检/导入按物流8位解析；第9位/普通采购第7位/大值整体拒绝',async()=>{
  const profile=sourceProductImportProfile('original_purchase'),row={外购成品编号:'HC-IMPORT',外购成品名称:'合成八位导入',品牌:'合成品牌',名称规格:'1',名称单位:'千克',系统规格:'千克',所属分类:'合成采购目录',供货方式:'原装采购',称重重量:'1',采购价:'1',运费:'0.12345678',装卸费:'0.12345678'};
  const sheets=[{name:profile.sheets[0].name,rows:[row]}],preview=await svc.importProfile(user,profile.id,sheets,true);expect(preview.results.filter(r=>r.errors.length)).toEqual([]);expect(preview.failed).toBe(0);expect((await svc.importProfile(user,profile.id,sheets,false,preview.signature!)).committed).toBe(true);
  const stored=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:user.companyId,type:'finance-products',title:'合成八位导入'});expect(stored.data).toMatchObject({freight:12.345678,handlingFee:12.345678,totalCost:124.691356});
  for(const extra of [{运费:'0.123456789'},{装卸费:'999999999.12345678'},{采购价:'0.1234567'}]){const before=await ds.manager.count(ResourceRecord,{where:{companyId:user.companyId}}),bad=await svc.importProfile(user,profile.id,[{name:profile.sheets[0].name,rows:[{...row,...extra}]}],true);expect(bad.failed).toBeGreaterThan(0);expect(await ds.manager.count(ResourceRecord,{where:{companyId:user.companyId}})).toBe(before);}
  for(const bad of [{freight:12.3456789},{handlingFee:99_999_999_999},{purchasePrice:12.345678}])await expect(svc.update(user,'finance-products',stored.id,bad)).rejects.toThrow();
 });
 it('真实档案八位来源进入普通登记六位/独立版本四位终点，验证与利润定价不抛精度错误',async()=>{
  const product=await svc.create(user,'finance-products',values('合成下游报价'));
  const auto=(await svc.list(user,'finance-base-codes',{fieldKey:'productId',fieldValue:String(product.id),showHidden:true,pageSize:100})).items.find(row=>row.data.origin==='archive_sync'&&row.data.canonicalId==null);expect(auto).toBeTruthy();const base=auto!;await svc.changeStatus(user,'finance-base-codes',base.id,'verified');
  const platform=await svc.create(user,'finance-platforms',{name:'合成平台',code:'HC'}),scenario=await svc.create(user,'finance-scenarios',{name:'合成场景',code:'HC',segment:'HC'}),category=await svc.create(user,'finance-categories',{archiveType:'bundle',name:'合成组合',code:'HC'});
  const bundle=await svc.create(user,'finance-bundles',{platformId:platform.id,scenarioId:scenario.id,bundleCategoryId:category.id});
  await svc.create(user,'finance-bundle-lines',{bundleId:bundle.id,baseCodeId:base.id,role:'main',qty:1});await svc.create(user,'finance-bundle-lines',{bundleId:bundle.id,productId:product.id,role:'gift',qty:1,unit:'KG',includeInJst:false});
  await svc.changeStatus(user,'finance-bundles',bundle.id,'verified');await svc.update(user,'finance-bundles',bundle.id,{manualFreight:100,marginOverridePercent:0,overrideReason:'合成精度下游'});
  const cost=new CostService(ds),row=await cost.one(user,bundle.id);expect((await svc.get(user,'finance-base-codes',base.id)).data.cost).toBe(124.69);expect(row).toMatchObject({preShipCostCents:249.3814,costIncludingFreightCents:349.3814,minPriceCents:350});expect(row.lines.find(line=>line.role==='gift')!.unitCostCents).toBe(124.691356);
  const seeds=await cost.versionSeeds(user);expect(seeds.seeds.find(seed=>seed.skuType==='base_code'&&seed.skuId===base.id)!.buckets).toMatchObject({purchase:100,transfer:24.69});expect(seeds.seeds.find(seed=>seed.skuType==='bundle'&&seed.skuId===bundle.id)!.buckets).toMatchObject({purchase:224.69,transfer:24.69});
  expect((await svc.get(user,'finance-products',product.id)).data.totalCost).toBe(124.691356);
  // 8位档案费用→真实mirror四位元；直接档案则到各自金额终点才舍入。
  await svc.update(user,'finance-products',product.id,{purchasePrice:1.2344,freight:0.000049,handlingFee:0.00005});expect((await svc.get(user,'finance-products',product.id)).data.totalCost).toBe(1.234499);expect((await svc.get(user,'finance-base-codes',base.id)).data.cost).toBe(1.23);await svc.changeStatus(user,'finance-base-codes',base.id,'verified');
  const make=async(configNo:string,mainQty:number,directQty:number)=>{const b=await svc.create(user,'finance-bundles',{platformId:platform.id,scenarioId:scenario.id,bundleCategoryId:category.id,configNo});await svc.create(user,'finance-bundle-lines',{bundleId:b.id,baseCodeId:base.id,role:'main',qty:mainQty});await svc.create(user,'finance-bundle-lines',{bundleId:b.id,productId:product.id,role:'gift',qty:directQty,unit:'KG',includeInJst:false});await svc.changeStatus(user,'finance-bundles',b.id,'verified');return b;};
  const hundred=await make('02',100,100),hundredRow=await cost.one(user,hundred.id);expect(hundredRow.preShipCostCents).toBe(246.4499);expect(hundredRow.lines.map(line=>[line.unitCostCents,line.subtotalCents])).toEqual([[1.23,123],[1.234499,123.4499]]);
  const ten=await make('03',1,10),nextSeeds=await cost.versionSeeds(user);expect(nextSeeds.seeds.find(seed=>seed.skuType==='bundle'&&seed.skuId===ten.id)!.buckets!.purchase).toBe(13.57);expect((await cost.one(user,ten.id)).preShipCostCents).toBe(13.575);
 });
});
