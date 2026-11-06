import 'reflect-metadata';
import {randomBytes,randomUUID} from 'crypto';
import {DataSource} from 'typeorm';
import {Company,User} from '../entities';
import {type AuthUser} from '../common/auth.decorators';
import {buildDataSourceOptions} from '../database/data-source';
import {buildServices} from '../test-support';
import {DesktopAfterSalesService} from './desktop-after-sales.service';
import {DesktopAfterSalesCollectionService} from './desktop-after-sales-collection.service';
import {DesktopAfterSalesCollaborationService} from './desktop-after-sales-collaboration.service';
import {AfterSalesService} from './after-sales.service';
import {collectionHealth,sourceChanges} from './desktop-after-sales-domain';
import {type DesktopSaleSnapshot} from '@kudesi/shared';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
const china=(d:Date)=>new Date(d.getTime()+8*3600000).toISOString().slice(0,19).replace('T',' ');
d('自有售后工作台、最新接力采集和协同（真实MySQL）',()=>{
 let ds:DataSource,svc:DesktopAfterSalesService,collector:DesktopAfterSalesCollectionService,collab:DesktopAfterSalesCollaborationService;
 let a:AuthUser,peer:AuthUser,reader:AuthUser,other:AuthUser,sourceId:number,saleId:number;
 let token:string;
 const fixedApplication=china(new Date(Date.now()-5000));
 const record=(id='85118801',fields:DesktopSaleSnapshot['fields']={}):DesktopSaleSnapshot=>({afterSaleId:id,internalOrderId:'44008801',sourceCompany:'演示来源',capturedAt:new Date().toISOString(),fields:{申请时间:fixedApplication,线上状态:'等待买家退货',...fields}});
 beforeAll(async()=>{
  ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never);await ds.initialize();const s=buildServices(ds);
  svc=new DesktopAfterSalesService(ds,s.crypto,s.files);collector=new DesktopAfterSalesCollectionService(ds,s.crypto,svc);collab=new DesktopAfterSalesCollaborationService(ds,svc,{} as AfterSalesService);
  async function company(){return ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(7).toString('hex'),name:'售后工作台测试',status:'active'}));}
  async function user(cid:number,account:string,admin=false):Promise<AuthUser>{const p=await ds.manager.save(User,ds.manager.create(User,{companyId:cid,account,name:account,passwordHash:'x',status:'active',mustChangePassword:false}));return {id:p.id,companyId:cid,name:p.name,permissions:{isCompanyAdmin:admin,allow:admin?[]:['after-sales.workspace.view'],deny:[]}};}
  const c=await company(),c2=await company();a=await user(c.id,'admin',true);peer=await user(c.id,'peer');reader=await user(c.id,'recipient');reader.permissions.allow=[];other=await user(c2.id,'outsider',true);
  sourceId=(await collector.configure(a,{sourceCompany:'演示来源',enabled:true,intervalSeconds:60})).id;
 });
 afterAll(async()=>{if(ds?.isInitialized){for(const cid of [a?.companyId,other?.companyId].filter(Boolean)){for(const table of ['desktop_after_sales_grants','desktop_after_sales_sources','desktop_after_sales_events','desktop_after_sales'])await ds.query(`DELETE FROM ${table} WHERE company_id=?`,[cid]);}await ds.destroy();}});
 it('一轮只交给一台客户端；其他客户端不分工其他页，且不能跨公司领取',async()=>{
  const leases=await Promise.all([collector.claim(a,sourceId,randomUUID()),collector.claim(peer,sourceId,randomUUID())]);expect(leases.filter(Boolean)).toHaveLength(1);
  const held=leases.find(Boolean)!;token=held.token;const owner=leases[0]?a:peer;
  await expect(collector.claim(other,sourceId,randomUUID())).rejects.toThrow(/不存在/);
  // Retry against the winning actor for the following test without exposing a lease credential.
  if(owner.id!==a.id){await collector.fail(owner,sourceId,token,'测试交还');await ds.query('UPDATE desktop_after_sales_sources SET next_query_at=NULL WHERE id=? AND company_id=?',[sourceId,a.companyId]);token=(await collector.claim(a,sourceId,randomUUID()))!.token;}
 });
 it('首次只采完整当前页，即使原列表有下一页也完成首轮',async()=>{
  await expect(collector.commit(a,sourceId,{token,records:[record('85118800',{申请时间:'1999-01-01 00:00:00'})],page:1,completed:true})).rejects.toThrow(/历史售后请在本机/);
  await expect(collector.commit(a,sourceId,{token,records:[record()],page:1,completed:false})).resolves.toEqual({received:1,completed:true});
  const source=(await collector.list(a))[0];expect(source.health).toBe('healthy');expect(source.collectedCount).toBe(1);expect(JSON.stringify(source)).not.toContain(token);
  saleId=(await svc.list(a,'85118801')).rows[0].id;expect((await svc.detail(a,saleId)).storeId).toBeNull();
  await expect(collector.commit(a,sourceId,{token,records:[record()],page:1,completed:true})).rejects.toThrow(/租约/);
 });
 it('失败显著可查、暂停会使旧结果无效；普通同事不能停止他人建立的公司采集',async()=>{
  await ds.query('UPDATE desktop_after_sales_sources SET next_query_at=NULL WHERE id=? AND company_id=?',[sourceId,a.companyId]);
  const round=(await collector.claim(a,sourceId,randomUUID()))!;
  token=round.token;
  expect(round.firstPageOnly).toBe(false);
  const latestApplication=Date.parse(fixedApplication.replace(' ','T')+'+08:00');
  expect(Date.parse(round.from)).toBe(latestApplication-30*60*1000);
  await collector.fail(a,sourceId,token,'页面失败 https://erp321.com/?token=private cookie=private');
  let s=(await collector.list(a))[0];expect(s.health).toBe('failed');expect(s.lastError).not.toContain('private');expect(s.lastSuccessAt).toBeTruthy();
  await expect(collector.configure(peer,{sourceCompany:'演示来源',enabled:false,intervalSeconds:60})).rejects.toThrow(/只有管理员/);
  await ds.query('UPDATE desktop_after_sales_sources SET next_query_at=NULL WHERE id=? AND company_id=?',[sourceId,a.companyId]);token=(await collector.claim(a,sourceId,randomUUID()))!.token;
  await collector.configure(a,{sourceCompany:'演示来源',enabled:false,intervalSeconds:60});
  await expect(collector.commit(a,sourceId,{token,records:[record()],page:1,completed:true})).rejects.toThrow(/租约/);s=(await collector.list(a))[0];expect(s.health).toBe('stopped');
 });
 it('历史本机回查追加变化和字段删除，重复读不刷历史，也不干扰人工办理版本',async()=>{
  let current=await svc.detail(a,saleId);const originalVersion=current.version;
  await svc.import(a,null,record('85118801',{售后标签:'需核对',实退金额:'50.00',原订单采购金额:'10.00'}));
  await svc.import(a,null,record('85118801',{售后标签:'',线上状态:'退款成功',实退金额:'54.29',原订单采购金额:'12.00'}));
  current=await svc.detail(a,saleId);expect(current.version).toBe(originalVersion);expect(current.snapshot.fields['售后标签']).toBe('');expect(current.events.some((e:{kind:string;content:string;actorName?:string})=>e.kind==='source_change'&&e.content.includes('需核对 → （空）'))).toBe(true);
  const count=current.events.length;await svc.import(a,null,record('85118801',{售后标签:'',线上状态:'退款成功',实退金额:'54.29',原订单采购金额:'12.00'}));expect((await svc.detail(a,saleId)).events.length).toBe(count);
  const masked=await svc.detail(peer,saleId);expect(masked.snapshot.fields['原订单采购金额']).toBeUndefined();expect(masked.events.filter((e:{kind:string;content:string;actorName?:string})=>e.kind==='source_change').some((e:{kind:string;content:string;actorName?:string})=>e.content.includes('54.29')||e.content.includes('12.00'))).toBe(false);
  expect((await svc.list(peer,'85118801')).rows[0].snapshot.fields['实退金额']).toBeUndefined();
 });
 it('颜色、紧急度和跟踪报告持久化；默认按申请时间而非最近办理时间排序',async()=>{
  const v=await svc.detail(a,saleId);const next=await svc.metadata(a,saleId,{version:v.version,priority:3,rowColor:'#d94b4b',report:'已联系仓库，等待签收核对'});
  expect(next.priority).toBe(3);expect(next.rowColor).toBe('#d94b4b');expect(next.report).toBe('已联系仓库，等待签收核对');
  const old=await svc.import(a,null,record('85118802',{申请时间:'2025-01-01 10:00:00'}));await svc.follow(a,old.id,{version:old.version,progress:'刚刚跟进旧单',note:'不改变原申请顺序'});
  expect((await svc.list(a)).rows[0].id).toBe(saleId);
  expect((await svc.list(a,'',1,'申请时间','asc')).rows[0].id).toBe(old.id);
  await svc.import(a,null,record('85118801',{买家退款账号:'fake-private-account',线上退运费:'6.00'}));
  const priced={...peer,permissions:{...peer.permissions,allow:['after-sales.workspace.view','product.price.view','product.cost.view']}};expect((await svc.detail(priced,saleId)).snapshot.fields['买家退款账号']).toBeUndefined();
  const [r]=await ds.query('SELECT report_enc FROM desktop_after_sales WHERE company_id=? AND id=?',[a.companyId,saleId]);expect(r.report_enc).not.toContain('已联系仓库');
 });
 it('跨部门推送只授权指定订单，站内通知指向受控详情；不能跨公司授权',async()=>{
  await expect(svc.assertAccess(reader,saleId)).rejects.toThrow(/协作权限/);
  await collab.share(a,saleId,[reader.id],'请接续核对退货签收',true);await expect(svc.assertAccess(reader,saleId,true)).resolves.toBeUndefined();
  const current=await svc.record(reader,saleId,'仓库：已收到，继续核对数量');expect(current.events.some((e:{kind:string;content:string;actorName?:string})=>e.actorName==='recipient')).toBe(true);
  const unrelated=(await svc.list(a,'85118802')).rows[0].id;await expect(svc.assertAccess(reader,unrelated)).rejects.toThrow(/协作权限/);
  expect(reader.permissions.allow).toEqual([]);
  const [notice]=await ds.query('SELECT link FROM notifications WHERE company_id=? AND user_id=? ORDER BY id DESC LIMIT 1',[a.companyId,reader.id]);expect(notice.link).toBe(`/after-sales/shared/${saleId}`);
  await expect(collab.share(a,saleId,[other.id],'不可跨公司',true)).rejects.toThrow(/本公司/);
 });
 it('本机回查历史订单不修改最新采集进度，也不会进入协同队列',async()=>{
  const [before]=await ds.query('SELECT watermark_at,next_page,collected_count,last_client_seen_at FROM desktop_after_sales_sources WHERE company_id=? AND id=?',[a.companyId,sourceId]);
  await collector.local(a,sourceId,[record('85118809',{申请时间:'2020-01-01 00:00:00',线上状态:'历史退款成功'})]);
  const [after]=await ds.query('SELECT watermark_at,next_page,collected_count,last_client_seen_at FROM desktop_after_sales_sources WHERE company_id=? AND id=?',[a.companyId,sourceId]);expect(after).toEqual(before);
  expect((await svc.list(a,'85118809')).rows).toHaveLength(1);
  await expect(collector.local(other,sourceId,[record()])).rejects.toThrow(/不存在/);
  await expect(collector.local(a,sourceId,[{...record(),sourceCompany:'另一来源'}])).rejects.toThrow(/来源不一致/);
 });
 it('掉线接力保留同一最新轮次和页次，不发放另一页给并行客户端',async()=>{
  await collector.configure(a,{sourceCompany:'演示来源',enabled:true,intervalSeconds:60});
  await ds.query('UPDATE desktop_after_sales_sources SET next_query_at=NULL,query_from=NULL,query_until=NULL,next_page=1,last_error_enc=NULL WHERE company_id=? AND id=?',[a.companyId,sourceId]);
  const first=(await collector.claim(a,sourceId,randomUUID()))!;
  await collector.commit(a,sourceId,{token:first.token,records:[record('85118810')],page:1,completed:false});
  expect(await collector.claim(peer,sourceId,randomUUID())).toBeNull();
  await ds.query('UPDATE desktop_after_sales_sources SET lease_until=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE company_id=? AND id=?',[a.companyId,sourceId]);
  expect((await collector.list(a))[0].health).toBe('failed');
  const takeover=(await collector.claim(peer,sourceId,randomUUID()))!;expect(takeover.page).toBe(2);expect(takeover.from).toBe(first.from);expect(takeover.until).toBe(first.until);
  expect((await collector.list(a))[0].health).toBe('failed');
  await expect(collector.commit(a,sourceId,{token:first.token,records:[],page:2,completed:true})).rejects.toThrow(/租约/);
  await collector.commit(peer,sourceId,{token:takeover.token,records:[],page:2,completed:true});expect((await collector.list(a))[0].health).toBe('healthy');
 });
 it('处理历史支持游标翻页，旧记录仍按价格权限过滤',async()=>{
  await ds.transaction(async em=>{for(let i=0;i<105;i++)await svc.appendRecordIn(em,a,saleId,`测试跟进记录 ${i}`);});
  const first=await svc.detail(a,saleId);expect(first.events).toHaveLength(100);expect(first.nextEventsBefore).toBeTruthy();
  const old=await svc.detail(peer,saleId,first.nextEventsBefore!);expect(old.events.length).toBeGreaterThan(0);expect(old.events.every((e:{id:number})=>e.id<first.nextEventsBefore!)).toBe(true);expect(old.snapshot.fields['实退金额']).toBeUndefined();
 });
 it('自动登记只允许管理员创建首个来源，匹配的客户端加入，已停用来源保持停止',async()=>{
  const local={...other,permissions:{...other.permissions,isCompanyAdmin:false}};
  expect(await collector.join(local,'演示来源')).toBeNull();
  const joined=(await collector.join(other,'演示来源'))!;
  expect(await collector.join(local,'演示来源')).toEqual(joined);
  expect(await collector.join(other,'另一公司')).toBeNull();
  await collector.configure(other,{sourceCompany:'演示来源',enabled:false,intervalSeconds:60});
  expect(await collector.join(other,'演示来源')).toEqual({id:joined.id,enabled:false});
 });
 it('列值筛选覆盖全部页，只能使用当前用户有权读到的值',async()=>{
  for(let i=0;i<32;i++)await svc.import(a,null,record(String(89110000+i),{退货签收时间:'2026-11-03 10:20:00',线上状态:'退款成功',实退金额:'81.55'}));
  await svc.import(other,null,record('89111111',{退货签收时间:'2026-11-03 10:20:00',线上状态:'退款成功',实退金额:'81.55'}));
  const filters=[{column:'退货签收时间' as const,value:'10:20'},{column:'线上状态' as const,value:'退款成功'}];
  const first=await svc.list(a,'',1,'售后单号','asc',filters);
  const second=await svc.list(a,'',2,'售后单号','asc',filters);
  expect(first.total).toBe(32);expect(first.rows).toHaveLength(30);
  expect(second.total).toBe(32);expect(second.rows.map(r=>r.afterSaleId)).toEqual(['89110030','89110031']);
  expect((await svc.list(peer,'',1,'申请时间','desc',[{column:'实退金额',value:'81.55'}])).total).toBe(0);
 });
 it('处理时回查只写入选中的售后，迟到的旧快照不会覆盖最新状态',async()=>{
  const snapshot={...record('85118801',{线上状态:'已退款'}),capturedAt:new Date(Date.now()+1000).toISOString()};
  await expect(svc.refreshSource(a,saleId,{...snapshot,internalOrderId:'99990000'})).rejects.toThrow(/当前售后不一致/);
  const latest=await svc.refreshSource(a,saleId,snapshot);
  expect(latest.events[0]).toMatchObject({kind:'source_change',actorName:'admin'});
  await svc.refreshSource(peer,saleId,{...snapshot,capturedAt:'2026-01-01T00:00:00.000Z',fields:{线上状态:'等待退货'}});
  expect((await svc.detail(a,saleId)).snapshot.fields['线上状态']).toBe('已退款');
 });
 it('首次空页不会把服务器时间当成已采集的申请时间',async()=>{
  const {id}=await collector.configure(a,{sourceCompany:'空页来源',enabled:true,intervalSeconds:60});
  const empty=(await collector.claim(a,id,randomUUID()))!;
  await collector.commit(a,id,{token:empty.token,records:[],page:1,completed:true});
  await ds.query('UPDATE desktop_after_sales_sources SET next_query_at=NULL WHERE company_id=? AND id=?',[a.companyId,id]);
  const next=(await collector.claim(a,id,randomUUID()))!;
  expect(next.firstPageOnly).toBe(true);
  await expect(collector.commit(a,id,{token:next.token,page:1,completed:true,records:[{...record('85229991',{申请时间:'2025-11-06 12:00:00'}),sourceCompany:'空页来源'}]})).resolves.toMatchObject({received:1});
 });
});
describe('售后源变化与告警状态',()=>{
 it('倒计时变化不冒充业务变更，清空标签是实际变更',()=>{
  const base={afterSaleId:'85118800',internalOrderId:'44008800',sourceCompany:'x',capturedAt:new Date().toISOString()};
  expect(sourceChanges({...base,fields:{线上状态:'待收货 还剩1天',售后标签:'标记'}},{...base,fields:{线上状态:'待收货 还剩12小时',售后标签:''}})).toEqual([{field:'售后标签',before:'标记',after:''}]);
 });
 it('客户端在线并不等于数据正常，超期、失败、关闭分别告警',()=>{
  const base={enabled:true,last_success_at:new Date(Date.now()-200000),last_failure_at:null,last_error_enc:null,lease_until:new Date(Date.now()+90000),interval_seconds:60};
  expect(collectionHealth(base)).toBe('stale');expect(collectionHealth({...base,last_error_enc:'encrypted'})).toBe('failed');expect(collectionHealth({...base,enabled:false})).toBe('stopped');
  expect(collectionHealth({...base,last_success_at:new Date(),last_client_seen_at:new Date(Date.now()-46000)})).toBe('waiting');
  expect(collectionHealth({...base,last_success_at:new Date(),last_client_seen_at:new Date()})).toBe('healthy');
 });
});
