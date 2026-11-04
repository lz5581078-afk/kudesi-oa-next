import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceChangeLog, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { BaseCodeToolsService } from './base-code-tools.service';
import { BundleToolsService } from './bundle-tools.service';
import { OutboxService } from '../outbox/outbox.service';
import { ResourcesService } from './resources.service';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('编码验证与启停独立事实（隔离数据库）',()=>{
 let ds:DataSource,svc:ResourcesService,actor:AuthUser,other:AuthUser,rawCategory:number,bundleCategory:number,platformId:number,scenarioId:number,serial=0;
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();svc=buildServices(ds).resources;
  const user=async()=>{const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'合成两轴',status:'active'}));const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'axes',passwordHash:'x',name:'合成管理员',isCompanyAdmin:true,status:'active',mustChangePassword:false}));return{id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};actor=await user();other=await user();
  rawCategory=(await svc.create(actor,'finance-categories',{archiveType:'raw',name:'合成原料',code:'RAW'})).id;
  bundleCategory=(await svc.create(actor,'finance-categories',{archiveType:'bundle',name:'合成组合',code:'BUNDLE'})).id;
  platformId=(await svc.create(actor,'finance-platforms',{name:'合成平台',code:'AX'})).id;scenarioId=(await svc.create(actor,'finance-scenarios',{name:'合成场景',code:'AX',segment:'AX'})).id;
 });
 afterAll(async()=>{jest.restoreAllMocks();await ds?.destroy();});
 const make=async()=>{const p=await svc.create(actor,'finance-products',{archiveType:'raw',categoryId:rawCategory,name:'合成原料'+ ++serial,code:'AXES-'+serial,specQty:1,specUnit:'KG',purchaseSpec:'千克',purchasePrice:100,freight:1,handlingFee:1});const base=(await svc.list(actor,'finance-base-codes',{fieldKey:'productId',fieldValue:String(p.id)})).items[0];await svc.changeStatus(actor,'finance-base-codes',base.id,'verified');return{p,base:await svc.get(actor,'finance-base-codes',base.id)};};
 const makeBundle=async(baseId:number)=>{const b=await svc.create(actor,'finance-bundles',{platformId,scenarioId,bundleCategoryId:bundleCategory,baseUnit:'千克'});await svc.create(actor,'finance-bundle-lines',{bundleId:b.id,baseCodeId:baseId,role:'main',qty:1,includeInJst:true});await svc.changeStatus(actor,'finance-bundles',b.id,'verified');return svc.get(actor,'finance-bundles',b.id);};
 const read=(type:string,id:number)=>svc.get(actor,type,id);
 it('基础停用保持已验证；无变更启用恢复verified且不新建baseline副本',async()=>{
  const {base}=await make();const stopped=await svc.changeStatus(actor,'finance-base-codes',base.id,'disabled','合成停用');expect(stopped).toMatchObject({status:'disabled',data:{verificationState:'verified'}});expect(stopped.data.signature).toBeUndefined();
  const restored=await svc.changeStatus(actor,'finance-base-codes',base.id,'active');expect(restored.status).toBe('verified');expect(restored.data.snapshot).toBe(base.data.snapshot);expect(restored.data).not.toHaveProperty('verificationBaseline');
 });
 it('停用期间源资料变化只标二次验证，基础/组合都不被重新启用；启用后需要重验',async()=>{
  const {p,base}=await make(),bundle=await makeBundle(base.id);
  await svc.changeStatus(actor,'finance-bundles',bundle.id,'inactive','合成停用');await svc.changeStatus(actor,'finance-base-codes',base.id,'disabled','合成停用');
  await svc.update(actor,'finance-products',p.id,{purchasePrice:123.4567});
  expect(await read('finance-base-codes',base.id)).toMatchObject({status:'disabled',data:{verificationState:'reverify'}});expect(await read('finance-bundles',bundle.id)).toMatchObject({status:'inactive',data:{verificationState:'reverify'}});
  expect((await new BaseCodeToolsService(ds,svc,{} as OutboxService).report(actor,base.id)).secondVerification).toBe(true);expect((await new BundleToolsService(ds,svc,{} as OutboxService).report(actor,bundle.id)).secondVerification).toBe(true);
  expect((await svc.changeStatus(actor,'finance-base-codes',base.id,'active')).status).toBe('reverify');expect((await svc.changeStatus(actor,'finance-bundles',bundle.id,'active')).status).toBe('reverify');
 });
 it('组合目录按真实bundleCategoryId/验证与启停投影，同公司统计不混旧未知',async()=>{
  const {base}=await make(),bundle=await makeBundle(base.id);await svc.changeStatus(actor,'finance-bundles',bundle.id,'inactive','合成停用');
  const tools=new BundleToolsService(ds,svc,{} as OutboxService);const summary=await tools.overview(actor);
  expect(summary.byBundleLifecycleCategory[String(bundleCategory)].verified.inactive).toBeGreaterThanOrEqual(1);
  expect(summary.byBundleLifecycleCategory[String(rawCategory)]).toBeUndefined();
  expect((await tools.overview(other)).byBundleLifecycleCategory).toEqual({});
 });
 it('组合专属编辑启停复用同一解析：未变恢复verified，停用时改名称仍停用并标重验',async()=>{
  const {base}=await make(),bundle=await makeBundle(base.id);
  const values={name:String(bundle.data.name),shortName:String(bundle.data.shortName),status:'inactive',statusReason:'合成停用'};
  await svc.confirmBundleProfile(actor,'finance-bundles',bundle.id,values);
  expect((await svc.confirmBundleProfile(actor,'finance-bundles',bundle.id,{...values,status:'active',statusReason:''})).status).toBe('verified');
  await svc.confirmBundleProfile(actor,'finance-bundles',bundle.id,values);
  expect(await svc.confirmBundleProfile(actor,'finance-bundles',bundle.id,{...values,name:'合成已改名'})).toMatchObject({status:'inactive',data:{verificationState:'reverify'}});
 });
 it('旧unknown不推断或混入已知tab；明确启用后是新的pending，普通伪造/跨公司/无启停权限拒绝',async()=>{
  const {base}=await make();const stored=(await ds.manager.findOneByOrFail(ResourceRecord,{id:base.id}));const data={...stored.data};delete data.verificationState;delete data.snapshot;delete data.signature;stored.status='disabled';stored.data=data;await ds.manager.save(ResourceRecord,stored);
  expect((await svc.list(actor,'finance-base-codes',{showHidden:true,filters:JSON.stringify({verificationState:'verified',enabledState:'inactive'})})).items.some(r=>r.id===base.id)).toBe(false);
  expect((await svc.list(actor,'finance-base-codes',{showHidden:true,filters:JSON.stringify({verificationState:'unknown',enabledState:'inactive'})})).items.map(r=>r.id)).toContain(base.id);
  await expect(svc.update(actor,'finance-base-codes',base.id,{verificationState:'verified'})).rejects.toMatchObject({status:403});
  await expect(svc.changeStatus(other,'finance-base-codes',base.id,'active')).rejects.toMatchObject({status:404});
  const viewer={...actor,permissions:{isCompanyAdmin:false,allow:['resource.finance-base-codes.view'],deny:[]}};await expect(svc.changeStatus(viewer,'finance-base-codes',base.id,'active')).rejects.toMatchObject({status:403});
  const enabled=await svc.changeStatus(actor,'finance-base-codes',base.id,'active');expect(enabled).toMatchObject({status:'pending',data:{verificationState:'pending'}});expect(enabled.data.snapshot).toBeUndefined();
  expect((await svc.exportCsv(actor,'finance-base-codes',false,{ids:[base.id]})).csv).not.toContain('verificationState');
 });
 it('最后审计步骤失败时状态/phase/快照/审计同事务回滚，重试可用',async()=>{
  const {base}=await make();const before=await read('finance-base-codes',base.id),logs=await ds.manager.countBy(ResourceChangeLog,{companyId:actor.companyId});
  const host=svc as unknown as {writeLog:(...args:unknown[])=>Promise<void>},original=host.writeLog.bind(svc);const spy=jest.spyOn(host,'writeLog').mockImplementation(async(...args)=>{if(args[3]===base.id)throw new Error('最后步骤合成失败');return original(...args);});
  await expect(svc.changeStatus(actor,'finance-base-codes',base.id,'disabled','合成停用')).rejects.toThrow('最后步骤合成失败');spy.mockRestore();
  expect(await read('finance-base-codes',base.id)).toEqual(before);expect(await ds.manager.countBy(ResourceChangeLog,{companyId:actor.companyId})).toBe(logs);
  expect((await svc.changeStatus(actor,'finance-base-codes',base.id,'disabled','合成停用')).status).toBe('disabled');
 });
});
