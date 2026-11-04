import 'reflect-metadata';
import {randomBytes} from 'node:crypto';
import {DataSource} from 'typeorm';
import type {AuthUser} from '../common/auth.decorators';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,FinanceMasterSnapshot,ResourceLink,ResourceRecord,User} from '../entities';
import {CostService} from './cost.service';
import {DataToolsService} from './data-tools.service';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('商品主数据清理原范围和历史快照（隔离库）',()=>{
 let ds:DataSource,tools:DataToolsService,actor:AuthUser;
 const person=async()=>{const c=await ds.manager.save(Company,ds.manager.create(Company,{code:'mr'+randomBytes(5).toString('hex'),name:'合成清理范围公司',status:'active'}));const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'admin',name:'合成核对员',passwordHash:'x',isCompanyAdmin:true,status:'active',mustChangePassword:false}));return{id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};
 const record=(type:string,title:string,data:Record<string,unknown>,who=actor)=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:who.companyId,type,title,data,status:'active',searchText:title,createdBy:who.id,updatedBy:who.id}));
 beforeAll(async()=>{ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true}).initialize();tools=new DataToolsService(ds,new CostService(ds));});
 beforeEach(async()=>{actor=await person();});afterAll(async()=>{await ds?.destroy();});
 it('供货来源、编码字典和普通单位纳入快照；档案类型/场景/独立价格事实保留，恢复原ID和关联',async()=>{
  const p=await record('finance-products','合成商品',{archiveType:'raw',code:'HC-1'}),source=await record('finance-product-sources','合成来源',{productId:p.id,purchasePrice:100}),unit=await record('finance-product-units','合成单位',{kind:'spec_unit',name:'合成袋',code:'HCD'}),kind=await record('finance-product-units','合成档案类型',{kind:'archive_type',name:'合成档案',code:'HC'}),dict=await record('finance-code-dictionaries','合成品种',{kind:'variety',name:'合成品种',code:'HCPZ'}),scene=await record('finance-scenarios','合成场景',{name:'合成场景',code:'HC'}),platform=await record('finance-platforms','合成平台',{name:'合成平台',code:'HC'}),history=await record('finance-product-purchase-history','合成历史',{productId:p.id,purchasePrice:100,recordedAtKey:'2026-11-03T00:00:00Z'});
  const link=await ds.manager.save(ResourceLink,ds.manager.create(ResourceLink,{companyId:actor.companyId,sourceType:history.type,sourceId:history.id,relation:'productId',targetType:p.type,targetId:p.id}));
  const other=await person(),theirs=await record('finance-products','外公司商品',{code:'OTHER'},other);
  const preview=await tools.resetPreview(actor,false);expect(preview.tables.find(t=>t.type===unit.type)?.count).toBe(1);expect(preview.tables.find(t=>t.type===dict.type)?.count).toBe(1);expect(preview.tables.some(t=>t.type===platform.type||t.type===scene.type)).toBe(false);
  const done=await tools.resetExecute(actor,{confirm:preview.confirmation,includePlatforms:false});
  for(const r of [p,source,unit,dict])expect(await ds.manager.findOneBy(ResourceRecord,{id:r.id,companyId:actor.companyId})).toBeNull();
  for(const r of [kind,scene,platform,history])expect(await ds.manager.findOneBy(ResourceRecord,{id:r.id,companyId:actor.companyId})).not.toBeNull();
  expect(await ds.manager.findOneBy(ResourceRecord,{id:theirs.id,companyId:other.companyId})).not.toBeNull();
  const restored=await tools.restore(actor,done.snapshot.id,`RESTORE-SNAPSHOT-${done.snapshot.id}`);expect(restored.restored).toBeGreaterThanOrEqual(5);
  for(const r of [p,source,unit,dict])expect((await ds.manager.findOneByOrFail(ResourceRecord,{id:r.id,companyId:actor.companyId})).data).toEqual(r.data);
  expect(await ds.manager.findOneBy(ResourceLink,{id:link.id,companyId:actor.companyId})).not.toBeNull();
 });
 it('平台选项只清销售平台，仍不清自定义销售场景或档案类型定义',async()=>{
  const platform=await record('finance-platforms','合成平台',{name:'合成平台'}),scene=await record('finance-scenarios','合成场景',{name:'合成场景'}),kind=await record('finance-product-units','合成档案',{kind:'archive_type',name:'合成档案'});
  const pre=await tools.resetPreview(actor,true);expect(pre.tables.find(t=>t.type===platform.type)?.count).toBe(1);expect(pre.tables.find(t=>t.type===kind.type)?.count).toBe(0);
  await tools.resetExecute(actor,{confirm:pre.confirmation,includePlatforms:true});expect(await ds.manager.findOneBy(ResourceRecord,{id:platform.id})).toBeNull();expect(await ds.manager.findOneBy(ResourceRecord,{id:scene.id})).not.toBeNull();expect(await ds.manager.findOneBy(ResourceRecord,{id:kind.id})).not.toBeNull();
 });
 it('旧快照按创建时types恢复，不因新增单位/编码字典范围而清掉后来资料',async()=>{
  const p=await record('finance-products','合成旧商品',{code:'OLD'}),snapshot=await ds.manager.save(FinanceMasterSnapshot,ds.manager.create(FinanceMasterSnapshot,{companyId:actor.companyId,operation:'reset',label:'合成历史范围',scopeJson:{includePlatforms:true,types:['finance-products']},snapshotJson:JSON.stringify({records:[p],links:[]}),rowCount:1,createdBy:actor.id}));
  await ds.manager.update(ResourceRecord,{id:p.id},{title:'合成新名称'});const dict=await record('finance-code-dictionaries','后来字典',{kind:'variety',name:'后来字典'}),unit=await record('finance-product-units','后来单位',{kind:'spec_unit',name:'后来单位'});
  await tools.restore(actor,snapshot.id,`RESTORE-SNAPSHOT-${snapshot.id}`);expect((await ds.manager.findOneByOrFail(ResourceRecord,{id:p.id})).title).toBe('合成旧商品');expect(await ds.manager.findOneBy(ResourceRecord,{id:dict.id})).not.toBeNull();expect(await ds.manager.findOneBy(ResourceRecord,{id:unit.id})).not.toBeNull();
 });
});
