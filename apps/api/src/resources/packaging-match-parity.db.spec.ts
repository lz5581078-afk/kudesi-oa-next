import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { CostService } from './cost.service';
import { DataToolsService } from './data-tools.service';
import { ResourcesService } from './resources.service';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('包装匹配原规则与只读明细（隔离数据库）',()=>{
 let ds:DataSource,svc:ResourcesService,tools:DataToolsService,actor:AuthUser,other:AuthUser;
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();svc=buildServices(ds).resources;tools=new DataToolsService(ds,new CostService(ds));
  const user=async()=>{const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'合成包装匹配',status:'active'}));const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'pack-match',passwordHash:'x',name:'合成管理员',isCompanyAdmin:true,status:'active',mustChangePassword:false}));return{id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};actor=await user();other=await user();
 });
 afterAll(async()=>{await ds?.destroy();});
 const scheme=(code:string,extra:Record<string,unknown>={},user=actor)=>svc.create(user,'finance-packaging-schemes',{schemeCode:code,schemeName:code,usageScene:'dispatch',...extra});
 const rule=(schemeId:number,targetCode:string,extra:Record<string,unknown>={},user=actor)=>svc.create(user,'finance-packaging-rules',{schemeId,targetType:'bundle',targetCode,priority:1,...extra});
 const match=(targetCode:string,weightKg=2,user=actor)=>tools.packagingMatch(user,{targetType:'bundle',usageScene:'dispatch',targetCode,weightKg});
 it('离散与真实区间AND，0/0空范围例外不改变保存事实',async()=>{
  const s=await scheme('MATCH-AND');await rule(s.id,'AND',{discreteWeights:'1,2',minWeightKg:1.5,maxWeightKg:2.5});
  expect((await match('AND',1)).selected).toBeNull();expect((await match('AND',2)).selected?.scheme.id).toBe(s.id);
  const blank=await scheme('MATCH-ZERO');const r=await rule(blank.id,'ZERO',{discreteWeights:'1,2',minWeightKg:0,maxWeightKg:0});
  expect((await match('ZERO',2)).selected?.scheme.id).toBe(blank.id);expect((await svc.get(actor,'finance-packaging-rules',r.id)).data).toMatchObject({minWeightKg:0,maxWeightKg:0,discreteWeights:'1,2'});
 });
 it('仅启用方案/规则及场景参与；日期保留但不额外过滤，同公司隔离',async()=>{
  const future=await scheme('MATCH-FUTURE',{effectiveFrom:'2099-01-01'}),expired=await scheme('MATCH-PAST',{effectiveTo:'2000-01-01'});
  const r=await rule(future.id,'DATE');await rule(expired.id,'PAST');
  expect((await match('DATE')).selected?.scheme.id).toBe(future.id);expect((await match('PAST')).selected?.scheme.id).toBe(expired.id);
  await svc.changeStatus(actor,'finance-packaging-rules',r.id,'inactive','合成停用');expect((await match('DATE')).selected).toBeNull();
  const production=await scheme('MATCH-PRODUCTION',{usageScene:'production'});await rule(production.id,'SCENE');expect((await match('SCENE')).selected).toBeNull();
  const foreign=await scheme('MATCH-FOREIGN',{},other);await rule(foreign.id,'FOREIGN',{},other);expect((await match('FOREIGN')).selected).toBeNull();expect((await match('FOREIGN',2,other)).selected?.scheme.id).toBe(foreign.id);
  await svc.changeStatus(other,'finance-packaging-schemes',foreign.id,'inactive','合成停用');expect((await match('FOREIGN',2,other)).selected).toBeNull();
 });
 it('命中明细按sortOrder再ID稳定显示，不改变实际组成',async()=>{
  const category=await svc.create(actor,'finance-categories',{archiveType:'package',name:'合成包装类',code:'PACK'});
  const product=async(name:string)=>svc.create(actor,'finance-products',{archiveType:'package',categoryId:category.id,name,specQty:1,specUnit:'PCS',purchaseSpec:'个',capacities:'500G',weightG:10,purchasePrice:1,freight:0,handlingFee:0,zeroValueReason:'运费：无\n装卸费：无'});
  const a=await product('合成包装甲'),b=await product('合成包装乙'),s=await scheme('MATCH-ORDER');await rule(s.id,'ORDER');
  for(const [id,qty,sortOrder] of [[a.id,1,20],[b.id,2,10],[a.id,3,10]])await svc.create(actor,'finance-packaging-lines',{schemeId:s.id,componentId:id,role:'package',qty,sortOrder,costTreatment:'include'});
  const result=await match('ORDER');expect(result.selected?.lines.map(line=>[line.componentName,line.qty])).toEqual([['合成包装乙',2],['合成包装甲',3],['合成包装甲',1]]);
 });
});
