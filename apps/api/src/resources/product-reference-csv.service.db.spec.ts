import 'reflect-metadata';
import {randomBytes} from 'crypto';
import {INestApplication,ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {DataSource} from 'typeorm';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,ResourceRecord,User} from '../entities';
import {AuthUser} from '../common/auth.decorators';
import {buildServices} from '../test-support';
import {ResourcesService} from './resources.service';
import {ResourcesController} from './resources.controller';
import {GridSaveService} from './grid-save.service';
import {DataToolsService} from './data-tools.service';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('R05原商品导出真实服务与HTTP（隔离MySQL）',()=>{
 let ds:DataSource,service:ResourcesService,boss:AuthUser,viewer:AuthUser,companyId:number,foreignCompanyId:number,app:INestApplication,url:string;
 let products:ResourceRecord[],empty:ResourceRecord,foreign:ResourceRecord,otherFamily:ResourceRecord,original:ResourceRecord,oem:ResourceRecord;
 const row=(type:string,data:Record<string,unknown>,company=companyId,status='active')=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:company,type,data,title:String(data.name||'合成导出记录'),status,createdBy:boss.id,updatedBy:boss.id}));
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:false} as never).initialize();service=buildServices(ds).resources;
  [companyId,foreignCompanyId]=(await ds.manager.save(Company,['本','外'].map(s=>ds.manager.create(Company,{code:'pe'+randomBytes(7).toString('hex'),name:'R05导出'+s,status:'active'})))).map(c=>c.id);
  const user=await ds.manager.save(User,ds.manager.create(User,{companyId,account:'admin',name:'导出合成管理员',passwordHash:'synthetic',status:'active',isCompanyAdmin:true}));
  boss={id:user.id,companyId,name:user.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
  const readUser=await ds.manager.save(User,ds.manager.create(User,{companyId,account:'viewer',name:'导出无成本合成员',passwordHash:'synthetic',status:'active',isCompanyAdmin:false}));
  viewer={id:readUser.id,companyId,name:readUser.name,permissions:{isCompanyAdmin:false,allow:['resource.finance-products.view','resource.finance-products.export'],deny:[]}};
  const category=await row('finance-categories',{archiveType:'raw',name:'真实分类'});
  products=await ds.manager.save(ResourceRecord,Array.from({length:205},(_,i)=>ds.manager.create(ResourceRecord,{companyId,type:'finance-products',title:'完整商品'+i,status:i===204?'inactive':'active',data:{archiveType:'raw',name:'完整商品'+i,code:'EXP-'+i,categoryId:category.id,specQty:1,specUnit:'KG',purchaseSpec:'千克',purchasePrice:234.5678,freight:34.5678,handlingFee:1},createdBy:boss.id,updatedBy:boss.id})));
  const supplier=await row('finance-suppliers',{name:'真实供货',shortCode:'REAL'});
  await ds.manager.save(ResourceRecord,products.map(p=>ds.manager.create(ResourceRecord,{companyId,type:'finance-product-sources',title:'完整来源',status:'active',data:{productId:p.id,supplierId:supplier.id,systemSpec:'千克',originArea:'产区',purchasePrice:234.5678},createdBy:boss.id,updatedBy:boss.id})));
  empty=await row('finance-products',{archiveType:'raw',name:'无来源不出CSV'});
  foreign=await row('finance-products',{archiveType:'raw',name:'外公司禁止'},foreignCompanyId);
  otherFamily=await row('finance-products',{archiveType:'package',name:'其它族禁止'});
  original=await row('finance-products',{archiveType:'purchased',name:'原装专属'});oem=await row('finance-products',{archiveType:'purchased',supplyMode:'supplier_oem',name:'OEM专属'});
  const archived=await row('finance-products',{archiveType:'purchased',name:'已归档禁止'});archived.archivedAt=new Date();await ds.manager.save(archived);
  await row('finance-products',{archiveType:'purchased',name:'已删除禁止'},companyId,'deleted');
  const module=await Test.createTestingModule({controllers:[ResourcesController],providers:[{provide:ResourcesService,useValue:service},{provide:GridSaveService,useValue:{}},{provide:DataToolsService,useValue:{}}]}).compile();app=module.createNestApplication();
  app.use((req:{headers:Record<string,string>;user?:AuthUser},_res:unknown,next:()=>void)=>{req.user=req.headers['x-test-actor']==='viewer'?viewer:boss;next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');url=await app.getUrl();
 });
 afterAll(async()=>{await app?.close();await ds?.destroy();});
 const full=(actor=boss,extra:Parameters<ResourcesService['exportCsv']>[3]={})=>service.exportCsv(actor,'finance-products',false,{referenceArchive:true,tab:'raw',...extra});
 it('完整205商品无LIMIT父查询，忽略keyword/分类/列筛选/虚拟列/排序；无来源不制造行',async()=>{
  const runner=ds.createQueryRunner();await runner.connect();const query=jest.spyOn(runner,'query');const originalManager=ds.manager;
  // Route only this read through an observable real QueryRunner; no mocked SQL results.
  const spy=jest.spyOn(originalManager,'createQueryBuilder').mockImplementation((...args:Parameters<typeof originalManager.createQueryBuilder>)=>runner.manager.createQueryBuilder(...args));
  try{
   const result=await full(boss,{keyword:'不存在',filters:JSON.stringify({categoryId:-99}),colFilters:JSON.stringify({name:'不存在'}),sortBy:'__notMetadata',derivedKeys:['__sourceCount','__sourceOrigin','__sourceSupplier','__categoryCode']});
   expect(result.count).toBe(205);expect(result.csv.split('\n')).toHaveLength(206);expect(result.csv).toContain('完整商品0');expect(result.csv).toContain('完整商品204');expect(result.csv).not.toMatch(/无来源不出CSV|外公司禁止|其它族禁止/);
   const parent=query.mock.calls.map(([sql])=>String(sql)).find(sql=>/FROM `resource_records` `r`/.test(sql)&&/ORDER BY.*id.*DESC/.test(sql));expect(parent).toBeDefined();expect(parent).not.toMatch(/LIMIT|OFFSET/i);
  }finally{spy.mockRestore();await runner.release();}
 });
 it('已选ID仍约束本公司和真实族，不允许跨公司或跨族混入',async()=>{
  const result=await full(boss,{ids:[products[0].id,foreign.id,otherFamily.id,empty.id]});expect(result.count).toBe(1);expect(result.csv).toContain('完整商品0');expect(result.csv).not.toMatch(/外公司禁止|其它族禁止|无来源/);
 });
 it('两外购族只收本scope，active/inactive可导出但deleted/archived不可',async()=>{
  for(const [family,yes,no]of [['original_purchase','原装专属','OEM专属'],['supplier_oem','OEM专属','原装专属']]){
   const result=await service.exportCsv(boss,'finance-products',true,{referenceArchive:true,tab:family,ids:[original.id,oem.id]});expect(result.count).toBe(1);expect(result.csv).toContain(yes);expect(result.csv).not.toContain(no);
  }
  const result=await service.exportCsv(boss,'finance-products',true,{referenceArchive:true,tab:'original_purchase'});expect(result.count).toBe(1);expect(result.csv).not.toMatch(/归档禁止|删除禁止/);
 });
 it('普通无成本查看者的真实服务导出无金额表头或值',async()=>{
  const result=await full(viewer,{ids:[products[0].id]});expect(result.count).toBe(1);expect(result.csv).toContain('完整商品0');expect(result.csv).not.toMatch(/采购价|运费|装卸费|2\.345678|0\.345678/);
 });
 it('真实HTTP保留tab+ids及令牌公司边界，虚拟cols不再触发metadata错误',async()=>{
  const response=await fetch(`${url}/resources/finance-products/export?referenceArchive=1&tab=raw&ids=${products[0].id},${foreign.id},${otherFamily.id}&cols=__sourceCount,__sourceSupplier&keyword=不存在&filters=%7B%7D`,{headers:{'x-test-actor':'viewer'}});
  expect(response.status).toBe(200);const result=await response.json() as {csv:string;count:number};expect(result.count).toBe(1);expect(result.csv).toContain('完整商品0');expect(result.csv).not.toMatch(/采购价|外公司禁止|其它族禁止/);
 });
 it('HTTP非法族/原型属性名和伪造公司明确400；helper不接受这些族',async()=>{
  for(const family of ['purchased','missing','__proto__','toString'])expect((await fetch(`${url}/resources/finance-products/export?referenceArchive=1&tab=${family}`)).status).toBe(400);
  expect((await fetch(`${url}/resources/finance-products/export?referenceArchive=1&tab=raw&companyId=${foreignCompanyId}`)).status).toBe(400);
 });
});
