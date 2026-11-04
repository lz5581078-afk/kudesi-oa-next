import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { OutboxService } from '../outbox/outbox.service';
import { buildServices } from '../test-support';
import { BundleToolsService } from './bundle-tools.service';
import { CostService } from './cost.service';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('组合主页整页摘要（隔离数据库）',()=>{
 let ds:DataSource,tools:BundleToolsService,actor:AuthUser,foreignCompany:number;
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();
  const services=buildServices(ds);tools=new BundleToolsService(ds,services.resources,new OutboxService(ds,services.resources));
  const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'合成整页摘要',status:'active'}));
  foreignCompany=(await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'合成其他公司',status:'active'}))).id;
  const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'summary',passwordHash:'x',name:'合成管理员',isCompanyAdmin:true,status:'active',mustChangePassword:false}));
  actor={id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
 });
 afterAll(async()=>{await ds?.destroy();});
 const insert=(type:string,data:Record<string,unknown>,companyId=actor.companyId)=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId,type,title:String(data.name||data.code||'合成摘要'),data,status:'active',createdBy:actor.id,updatedBy:actor.id}));
 it('只加载一次成本目录，按实际行数列组成/包装，成本重量复用现计算且售价只计普通镜像非赠品',async()=>{
  const product=await insert('finance-products',{archiveType:'package',totalCost:8.1234,weightG:5,purchaseSpec:'张'});
  const base=await insert('finance-base-codes',{productId:product.id,code:'BZ-SUM',name:'合成包装',salePrice:99999});
  await insert('finance-jst-skus',{skuId:'BZ-SUM',goodsType:'normal',salePrice:312.3456});
  await insert('finance-jst-skus',{skuId:'BZ-SUM',goodsType:'combine',salePrice:99999},foreignCompany);
  const bundle=await insert('finance-bundles',{code:'ZH-SUM',mainStyleCode:'ZH-STYLE'});
  for(const [role,qty] of [['main',2],['package',1],['gift',3]] as const)await insert('finance-bundle-lines',{bundleId:bundle.id,baseCodeId:base.id,role,qty});
  const load=jest.spyOn(CostService.prototype,'load');
  const summary=(await tools.summaries(actor,[bundle.id])).rows[0];expect(load).toHaveBeenCalledTimes(1);load.mockRestore();
  expect(summary).toMatchObject({mainStyleCode:'ZH-STYLE',componentCount:3,packageCount:3,weightG:30,cost:48.7404,salePrice:937.0368});
  expect(summary.packageSummary.split('；')).toHaveLength(3);
  const costData=await new CostService(ds).load(actor.companyId);expect(summary.cost).toBe(new CostService(ds).row(costData,bundle).preShipCostCents);
 });
 it('没有真实普通镜像返回null，可信0保留；cost/price服务端分别脱敏且公司隔离',async()=>{
  const base=await insert('finance-base-codes',{code:'ZERO-SUM',salePrice:9999}),bundle=await insert('finance-bundles',{code:'ZERO-BUNDLE'});
  await insert('finance-bundle-lines',{bundleId:bundle.id,baseCodeId:base.id,role:'main',qty:2});
  await insert('finance-jst-skus',{skuId:'ZERO-SUM',goodsType:'combine',salePrice:55});
  expect((await tools.summaries(actor,[bundle.id])).rows[0].salePrice).toBeNull();
  await insert('finance-jst-skus',{skuId:'ZERO-SUM',goodsType:'normal',salePrice:0});
  expect((await tools.summaries(actor,[bundle.id])).rows[0].salePrice).toBe(0);
  const viewer={...actor,permissions:{isCompanyAdmin:false,allow:['resource.finance-bundles.view'],deny:[]}};
  const hidden=(await tools.summaries(viewer,[bundle.id])).rows[0];expect(hidden).not.toHaveProperty('cost');expect(hidden).not.toHaveProperty('salePrice');
  for(const [permission,visible,absent] of [['product.cost.view','cost','salePrice'],['product.price.view','salePrice','cost']]){
   const row=(await tools.summaries({...viewer,permissions:{...viewer.permissions,allow:[...viewer.permissions.allow,permission]}},[bundle.id])).rows[0];expect(row).toHaveProperty(visible);expect(row).not.toHaveProperty(absent);
  }
  const foreign=await insert('finance-bundles',{code:'FOREIGN'},foreignCompany);
  await expect(tools.summaries(actor,[bundle.id,foreign.id])).rejects.toMatchObject({status:404});
  await expect(tools.summaries({...viewer,permissions:{...viewer.permissions,allow:[]}},[bundle.id])).rejects.toMatchObject({status:403});
 });
 it('ID正整数唯一/200上限在服务边界复核',async()=>{
  for(const ids of [[1,1],[0],[-1],[1.1],[Number.MAX_SAFE_INTEGER+1],Array.from({length:201},(_,i)=>i+1)])await expect(tools.summaries(actor,ids)).rejects.toMatchObject({status:400});
 });
 it('原BOM直接档案只读事实可查看，保留原上传flag并列问题，跨公司来源不泄露',async()=>{
  const product=await insert('finance-products',{archiveType:'oem_package',code:'DIRECT-PKG',totalCost:8,weightG:5});
  const bundle=await insert('finance-bundles',{code:'DIRECT-BUNDLE',name:'合成直接档案组合'});
  const line=await insert('finance-bundle-lines',{bundleId:bundle.id,productId:product.id,role:'package',qty:2,includeInJst:true});
  const summary=(await tools.summaries(actor,[bundle.id])).rows[0];expect(summary).toMatchObject({componentCount:1,packageCount:1,cost:16,weightG:10,salePrice:null});expect(summary.packageSummary).toContain('DIRECT-PKG');
  const report=await tools.report(actor,bundle.id);expect(report.components[0]).toMatchObject({productId:product.id,code:'DIRECT-PKG',qty:2,cost:8,weightG:5,includeInJst:true});expect(report.issues.join('；')).toMatch(/上传.*基础编码|基础编码.*上传/);
  const foreign=await insert('finance-products',{archiveType:'package',code:'PRIVATE-DIRECT',name:'不能泄露',totalCost:999,weightG:999},foreignCompany);
  await ds.manager.update(ResourceRecord,{id:line.id},{data:{...line.data,productId:foreign.id}});
  const hidden=await tools.report(actor,bundle.id);expect(JSON.stringify(hidden)).not.toContain('PRIVATE-DIRECT');expect(hidden.components[0].cost).toBeNull();
 });

});
