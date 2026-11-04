import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceChangeLog, ResourceLink, ResourceRecord, User } from '../entities';
import { OutboxService } from '../outbox/outbox.service';
import { buildServices } from '../test-support';
import { BundleToolsService } from './bundle-tools.service';
import { ResourcesService } from './resources.service';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('组合删除原子性（隔离数据库）',()=>{
 let ds:DataSource,svc:ResourcesService,tools:BundleToolsService,boss:AuthUser,other:AuthUser,baseId:number,platformId:number,scenarioId:number,categoryId:number,sourceId:number;
 let serial=0;
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true} as never).initialize();
  svc=buildServices(ds).resources;tools=new BundleToolsService(ds,svc,new OutboxService(ds,svc));
  const actor=async()=>{const c=await ds.manager.save(Company,ds.manager.create(Company,{code:`del${randomBytes(5).toString('hex')}`,name:'合成删除隔离公司',status:'active'}));const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'admin',passwordHash:'x',name:'合成管理员',isCompanyAdmin:true,status:'active',mustChangePassword:false}));return{id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};
  boss=await actor();other=await actor();
  const rawCategory=await svc.create(boss,'finance-categories',{archiveType:'raw',name:'合成原料类',code:'RAW'});
  const p=await svc.create(boss,'finance-products',{archiveType:'raw',categoryId:rawCategory.id,name:'合成原料',code:'DELETE-RAW',specQty:1,specUnit:'KG',purchaseSpec:'千克',weightG:100,purchasePrice:100,freight:1,handlingFee:1});sourceId=p.id;
  baseId=(await svc.list(boss,'finance-base-codes',{fieldKey:'productId',fieldValue:String(p.id),pageSize:200})).items[0].id;
  await svc.changeStatus(boss,'finance-base-codes',baseId,'verified');
  platformId=(await svc.create(boss,'finance-platforms',{name:'合成平台',code:'DEL'})).id;
  scenarioId=(await svc.create(boss,'finance-scenarios',{name:'合成场景',code:'SALE'})).id;
  categoryId=(await svc.create(boss,'finance-categories',{archiveType:'bundle',name:'合成组合类',code:'BUNDLE'})).id;
 });
 afterAll(async()=>{jest.restoreAllMocks();await ds?.destroy();});
 const make=async()=>{const b=await svc.create(boss,'finance-bundles',{platformId,scenarioId,bundleCategoryId:categoryId,configNo:String(++serial)});const a=await svc.create(boss,'finance-bundle-lines',{bundleId:b.id,baseCodeId:baseId,role:'main',qty:1});const z=await svc.create(boss,'finance-bundle-lines',{bundleId:b.id,baseCodeId:baseId,role:'other',qty:1});return{b:await svc.get(boss,'finance-bundles',b.id),a,z};};
 const graph=async()=>({records:(await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}})).map(r=>[r.id,r.type,r.data,r.status,r.uniqueKey]),logs:(await ds.manager.find(ResourceChangeLog,{where:{companyId:boss.companyId},order:{id:'ASC'}})).map(r=>[r.id,r.resourceId,r.action,r.beforeJson,r.afterJson])});
 it('后项真实引用失败时前项BOM、主档和删除/更新日志全部回滚',async()=>{
  const {b,z}=await make(),pre=await tools.deletionPreview(boss,b.id);
  const link=await ds.manager.save(ResourceLink,ds.manager.create(ResourceLink,{companyId:boss.companyId,sourceType:'finance-products',sourceId,relation:'synthetic-reference',targetType:'finance-bundle-lines',targetId:z.id}));
  const before=await graph();
  await expect(tools.deletionExecute(boss,b.id,pre.token,pre.code,'合成删除')).rejects.toThrow(/引用/);
  expect(await graph()).toEqual(before);
  await ds.manager.delete(ResourceLink,link.id);
  const fresh=await tools.deletionPreview(boss,b.id);
  await tools.deletionExecute(boss,b.id,fresh.token,fresh.code,'合成删除');
  expect((await svc.list(boss,'finance-bundle-lines',{fieldKey:'bundleId',fieldValue:String(b.id),pageSize:200})).items).toHaveLength(0);
 });
 it('构成备注改变也使token过期，错误公司和错误确认码均不能删除',async()=>{
  const {b,z}=await make(),pre=await tools.deletionPreview(boss,b.id);
  await ds.manager.update(ResourceRecord,{id:z.id,companyId:boss.companyId},{data:{...z.data,note:'合成并发修改'}});
  const before=await graph();
  await expect(tools.deletionExecute(boss,b.id,pre.token,pre.code,'合成删除')).rejects.toThrow(/预览/);
  const fresh=await tools.deletionPreview(boss,b.id);
  await expect(tools.deletionExecute(boss,b.id,fresh.token,'WRONG','合成删除')).rejects.toThrow(/完整输入/);
  await expect(tools.deletionExecute(other,b.id,fresh.token,fresh.code,'合成删除')).rejects.toThrow(/不存在/);
  expect(await graph()).toEqual(before);
 });
 it('删除持有父锁时新增构成等待，删除完成后拒绝且无孤儿',async()=>{
  const {b,a}=await make(),pre=await tools.deletionPreview(boss,b.id);
  let entered!:()=>void,release!:()=>void;
  const locked=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
  const remove=svc.removeRecord.bind(svc);
  const spy=jest.spyOn(svc,'removeRecord').mockImplementation(async(...args)=>{if(args[3]===a.id){entered();await gate;}return remove(...args);});
  const deleting=tools.deletionExecute(boss,b.id,pre.token,pre.code,'合成删除');
  await locked;
  const adding=svc.create(boss,'finance-bundle-lines',{bundleId:b.id,baseCodeId:baseId,role:'auxiliary',qty:1}).then(()=>({ok:true,error:''}),e=>({ok:false,error:String(e.message)}));
  try{expect(await Promise.race([adding.then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),40))])).toBe(false);}finally{release();}
  await deleting;expect(await adding).toMatchObject({ok:false});spy.mockRestore();
  expect((await svc.list(boss,'finance-bundle-lines',{fieldKey:'bundleId',fieldValue:String(b.id),pageSize:200})).items).toHaveLength(0);
 });
});
