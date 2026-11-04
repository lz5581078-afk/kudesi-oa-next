import 'reflect-metadata';
import {randomBytes} from 'crypto';
import {DataSource} from 'typeorm';
import {type DesktopSaleSnapshot} from '@kudesi/shared';
import {Company,User} from '../entities';
import {type AuthUser} from '../common/auth.decorators';
import {buildDataSourceOptions} from '../database/data-source';
import {buildServices} from '../test-support';
import {cutoverTables} from '../migration/cutover';
import {DesktopAfterSalesService} from './desktop-after-sales.service';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('桌面售后（真实 MySQL）',()=>{
 let ds:DataSource,s:ReturnType<typeof buildServices>,svc:DesktopAfterSalesService,a:AuthUser,b:AuthUser,store:number,otherStore:number,id:number;
 const snapshot=(fields:DesktopSaleSnapshot['fields']={}):DesktopSaleSnapshot=>({afterSaleId:'85110001',internalOrderId:'4400001',sourceCompany:'演示聚水潭公司',capturedAt:new Date().toISOString(),fields:{线上状态:'等待退货',...fields}});
 beforeAll(async()=>{
  ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never);await ds.initialize();s=buildServices(ds);svc=new DesktopAfterSalesService(ds,s.crypto,s.files);
  async function user(){const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'桌面测试',status:'active'}));const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'admin',name:'测试客服',passwordHash:'x',status:'active',mustChangePassword:false}));return {id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};}
  a=await user();b=await user();
  store=(await s.resources.create(a,'stores',{platform:'douyin',name:'桌面演示店',storeNo:'D001',claimStatus:'public'} as never)).id;
  otherStore=(await s.resources.create(b,'stores',{platform:'douyin',name:'其他公司店',storeNo:'D002',claimStatus:'public'} as never)).id;
  await s.settings.saveQiniu(a,{accessKey:'test-ak',secretKey:'test-sk',bucket:'test',zone:'z0',domain:'https://cdn.example.com',isPrivate:true});
 });
 afterAll(async()=>{if(ds?.isInitialized){for(const cid of [a?.companyId,b?.companyId].filter(Boolean)){await ds.query('DELETE FROM desktop_after_sales_events WHERE company_id=?',[cid]);await ds.query('DELETE FROM desktop_after_sales WHERE company_id=?',[cid]);}await ds.destroy();}});
 it('公司隔离，未知字段与无效标识拒绝',async()=>{
  await expect(svc.import(a,otherStore,snapshot())).rejects.toThrow(/有效店铺/);
  await expect(svc.import(a,store,{...snapshot(),internalOrderId:''})).rejects.toThrow(/内部订单号/);
  await expect(svc.import(a,store,snapshot({cookie:'secret'} as never))).rejects.toThrow(/不支持/);
  const v=await svc.import(a,store,snapshot({卖家备注:'联系电话 13800000000 https://erp321.com/?jmxToken=secret\nAuthorization: Bearer secret'}));id=v.id;
  expect(v.snapshot.fields['卖家备注']).not.toContain('secret');
  await expect(svc.detail(b,id)).rejects.toThrow(/不存在/);expect((await svc.list(b)).total).toBe(0);
  const [r]=await ds.query('SELECT snapshot_enc FROM desktop_after_sales WHERE company_id=? AND id=?',[a.companyId,id]);expect(r.snapshot_enc).not.toContain('13800000000');expect(r.snapshot_enc).toMatch(/^v1:/);
 });
 it('重读不会覆盖跟进、负责人和已读详情；冲突版本拒绝',async()=>{
  const v=await svc.detail(a,id);const followed=await svc.follow(a,id,{version:v.version,progress:'等待物流',note:'已经联系买家',ownerId:a.id,nextAt:'2026-11-06T10:00:00.000Z'});
  await expect(svc.follow(a,id,{version:v.version,progress:'旧修改',note:'x'})).rejects.toThrow(/已被更新/);
  await svc.import(a,store,snapshot({售后日志:'原系统日志'}));const again=await svc.import(a,store,snapshot({线上状态:'买家已退货'}));
  expect(again.progress).toBe('等待物流');expect(again.ownerId).toBe(a.id);expect(again.nextAt).toEqual(followed.nextAt);expect(again.snapshot.fields['售后日志']).toBe('原系统日志');expect(again.events.some((e:{content:string})=>e.content.includes('已经联系买家'))).toBe(true);
  await expect(svc.import(a,store,{...snapshot(),internalOrderId:'9900000'})).rejects.toThrow(/另一店铺或订单/);
 });
 it('拒绝跨公司负责人；原始内容按成本和价格权限过滤',async()=>{
  const v=await svc.detail(a,id);await expect(svc.follow(a,id,{version:v.version,progress:'x',note:'x',ownerId:b.id})).rejects.toThrow(/本公司/);
  await svc.import(a,store,snapshot({实退金额:'54.29',商品信息:'商品 成本10元',售后日志:'成交单价记录'}));
  const restricted={...a,permissions:{isCompanyAdmin:false,allow:['after-sales.workspace.view'],deny:[]}};
  const limited=await svc.detail(restricted,id);expect(limited.snapshot.fields['实退金额']).toBeUndefined();expect(limited.snapshot.fields['商品信息']).toBeUndefined();expect(limited.snapshot.fields['售后日志']).toBeUndefined();expect(limited.snapshot.fields['线上状态']).toBeTruthy();
 });
 it('附件必须属于同公司同档案；上传更新版本，不覆盖跟进',async()=>{
  const buffer=Buffer.from([137,80,78,71,13,10,26,10,0]);const v=await svc.upload(a,id,{originalname:'测试.png',buffer,size:buffer.length});expect(v.files).toHaveLength(1);expect(v.progress).toBe('等待物流');expect((await svc.fileUrl(a,id,v.files[0].id)).url).toMatch(/^https:/);
  await expect(svc.fileUrl(b,id,v.files[0].id)).rejects.toThrow(/不存在/);
  const second=await svc.import(a,store,{...snapshot(),afterSaleId:'85110002'});await expect(svc.fileUrl(a,second.id,v.files[0].id)).rejects.toThrow(/附件不存在/);
 });
 it('有售后建档时拒绝破坏性整库重迁',async()=>{await expect(cutoverTables(ds)).rejects.toThrow(/桌面售后已有/);});
 it('同时首次读取只产生一个档案，不串单',async()=>{
  const input={...snapshot(),afterSaleId:'85110003'};const [x,y]=await Promise.all([svc.import(a,store,input),svc.import(a,store,input)]);expect(x.id).toBe(y.id);const [r]=await ds.query('SELECT COUNT(*) AS n FROM desktop_after_sales WHERE company_id=? AND after_sale_id=?',[a.companyId,input.afterSaleId]);expect(Number(r.n)).toBe(1);
 });
});
