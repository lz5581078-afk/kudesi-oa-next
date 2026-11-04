import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord } from '../entities';
import { buildServices } from '../test-support';
import { composeBundleFor } from './finance-rules';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('组合主款式当前真实来源（隔离数据库）',()=>{
 let ds:DataSource,actor:AuthUser,base:ResourceRecord,bundle:ResourceRecord;
 const insert=(type:string,data:Record<string,unknown>)=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:actor.companyId,type,title:String(data.name||data.code||'合成主款式'),data,status:'active',createdBy:null,updatedBy:null}));
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();
  const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'合成主款式',status:'active'}));actor={id:0,companyId:c.id,name:'合成系统',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
  const category=await insert('finance-categories',{name:'合成类',code:'HC',archiveType:'raw'}),product=await insert('finance-products',{name:'合成主品',code:'RAW-MAIN',archiveType:'raw',categoryId:category.id,specQty:1,specUnit:'KG',purchaseSpec:'千克',weightG:1000,totalCost:100});
  base=await insert('finance-base-codes',{name:'合成主品',shortName:'合成',code:'BASE-MAIN',styleCode:'BASE',productId:product.id});
  const platform=await insert('finance-platforms',{name:'合成平台',code:'TEST'}),scenario=await insert('finance-scenarios',{name:'合成场景',code:'standard'});
  bundle=await insert('finance-bundles',{platformId:platform.id,scenarioId:scenario.id,manualCode:'MANUAL-MAIN',manualName:'合成组合',manualStyleCode:'CUSTOM+ZP-G*2',manualReason:'合成手改'});
  await insert('finance-bundle-lines',{bundleId:bundle.id,baseCodeId:base.id,role:'main',qty:1});
 });
 afterAll(async()=>{await ds?.destroy();});
 it('最终手改款式生成主款式，不误用自动主品结果',async()=>{
  const result=await composeBundleFor(buildServices(ds).resources,ds.manager,actor,bundle);
  expect(result?.patch).toMatchObject({mainStyleCode:'CUSTOM',styleCode:'CUSTOM+ZP-G*2'});
 });
 it('资料不全且没有明确最终手改款式不补猜测值，有明确手改仍可取真实主款式',async()=>{
  await insert('finance-bundle-lines',{bundleId:bundle.id,baseCodeId:base.id,role:'gift',qty:1});
  const incomplete={...bundle,data:{...bundle.data,manualStyleCode:undefined}} as ResourceRecord;
  const result=await composeBundleFor(buildServices(ds).resources,ds.manager,actor,incomplete);expect(result?.patch.mainStyleCode).toBeUndefined();
  const known=await composeBundleFor(buildServices(ds).resources,ds.manager,actor,bundle);expect(known?.patch.mainStyleCode).toBe('CUSTOM');
 });
});
