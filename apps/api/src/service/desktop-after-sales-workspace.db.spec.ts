import 'reflect-metadata';
import {ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {randomBytes,randomUUID} from 'crypto';
import {DataSource} from 'typeorm';
import {Company,User} from '../entities';
import {type AuthUser} from '../common/auth.decorators';
import {buildDataSourceOptions} from '../database/data-source';
import {buildServices} from '../test-support';
import {DesktopAfterSalesService} from './desktop-after-sales.service';
import {DesktopAfterSalesCollectionService} from './desktop-after-sales-collection.service';
import {DesktopAfterSalesCollectionController} from './desktop-after-sales.controller';
import {DesktopAfterSalesCollaborationService} from './desktop-after-sales-collaboration.service';
import {AfterSalesService} from './after-sales.service';
import {applicationAt,collectionHealth,sourceChanges} from './desktop-after-sales-domain';
import {type DesktopSaleSnapshot} from '@kudesi/shared';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
const china=(d:Date)=>new Date(d.getTime()+8*3600000).toISOString().slice(0,19).replace('T',' ');
d('自有售后工作台、最新接力采集和协同（真实MySQL）',()=>{
 let ds:DataSource,svc:DesktopAfterSalesService,collector:DesktopAfterSalesCollectionService,collab:DesktopAfterSalesCollaborationService;
 let a:AuthUser,peer:AuthUser,reader:AuthUser,other:AuthUser,sourceId:number,saleId:number;
 let token:string;
 let crypto:ReturnType<typeof buildServices>['crypto'];
 const fixedApplication=china(new Date(Date.now()-5000));
 const record=(id='85118801',fields:DesktopSaleSnapshot['fields']={}):DesktopSaleSnapshot=>({afterSaleId:id,internalOrderId:'44008801',sourceCompany:'演示来源',capturedAt:new Date().toISOString(),fields:{申请时间:fixedApplication,线上状态:'等待买家退货',...fields}});
 beforeAll(async()=>{
  ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never);await ds.initialize();const s=buildServices(ds);crypto=s.crypto;
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
  const [leased]=await ds.query('SELECT lease_started_at FROM desktop_after_sales_sources WHERE company_id=? AND id=?',[a.companyId,sourceId]);
  const nextQueryAt=new Date(leased.lease_started_at.getTime()+60000).toISOString();
  await expect(collector.commit(a,sourceId,{token,records:[record()],page:1,completed:false})).resolves.toEqual({received:1,completed:true,nextQueryAt});
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
 it('历史本机回查追加变化和清空字段，每次新读取留痕，原样重试不刷历史',async()=>{
  let current=await svc.detail(a,saleId);const originalVersion=current.version;
  await svc.import(a,null,record('85118801',{售后标签:'需核对',实退金额:'50.00',原订单采购金额:'10.00'}));
  await svc.import(a,null,record('85118801',{售后标签:'',线上状态:'退款成功',实退金额:'54.29',原订单采购金额:'12.00'}));
  current=await svc.detail(a,saleId);expect(current.version).toBe(originalVersion);expect(current.snapshot.fields['售后标签']).toBe('');expect(current.events.some((e:{kind:string;content:string;actorName?:string})=>e.kind==='source_change'&&e.content.includes('需核对 → （空）'))).toBe(true);
  const count=current.events.length;
  const reread={...current.snapshot,capturedAt:new Date(Date.parse(current.snapshot.capturedAt)+1).toISOString()};
  await svc.import(a,null,reread);
  expect((await svc.detail(a,saleId)).events[0]).toMatchObject({kind:'source_read',createdAt:new Date(reread.capturedAt)});
  await svc.import(a,null,reread);
  expect((await svc.detail(a,saleId)).events.length).toBe(count+1);
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
  await collector.commit(peer,sourceId,{token:takeover.token,records:[],page:2,completed:false});
  await expect(collector.yield(a,sourceId,takeover.token)).rejects.toThrow(/租约/);
  await expect(collector.yield(peer,sourceId,takeover.token)).resolves.toEqual({released:true});
  const resumed=(await collector.claim(a,sourceId,randomUUID()))!;
  expect(resumed).toMatchObject({page:3,from:first.from,until:first.until});
  await expect(collector.commit(peer,sourceId,{token:takeover.token,records:[],page:3,completed:true})).rejects.toThrow(/租约/);
  await collector.commit(a,sourceId,{token:resumed.token,records:[],page:3,completed:true});expect((await collector.list(a))[0].health).toBe('healthy');
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
 it('从同一公司和来源已有申请时间向前补30分钟，交叠重复提交只留一条',async()=>{
  const sourceCompany='已有档案来源';
  const archivedAt=new Date('2026-01-01T08:00:00.000Z');
  const archived={...record('85229992',{申请时间:china(archivedAt)}),sourceCompany};
  await svc.import(a,null,archived);
  await svc.import(a,null,{...record('85229993'),sourceCompany:'不同来源'});
  await svc.import(other,null,{...record('85229994'),sourceCompany});
  const {id}=await collector.configure(a,{sourceCompany,enabled:true,intervalSeconds:60});
  const first=(await collector.claim(a,id,randomUUID()))!;
  expect(first).toMatchObject({from:'2026-01-01T07:30:00.000Z',firstPageOnly:false});
  const overlap={...archived,capturedAt:new Date().toISOString(),fields:{...archived.fields,线上状态:'已完成'}};
  await collector.commit(a,id,{token:first.token,page:1,completed:true,records:[overlap]});
  const rows=(await svc.list(a,archived.afterSaleId)).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].snapshot.fields['线上状态']).toBe('已完成');
  await ds.query('UPDATE desktop_after_sales_sources SET next_query_at=NULL,watermark_at=? WHERE company_id=? AND id=?',[new Date(),a.companyId,id]);
  const second=(await collector.claim(a,id,randomUUID()))!;
  expect(second.from).toBe(first.from);
 });
 it('第31条缺内部订单号时整页仍能通过HTTP入库，回查补号后不会被空值覆盖',async()=>{
  const sourceCompany='待补内部订单来源';
  const {id}=await collector.configure(a,{sourceCompany,enabled:true,intervalSeconds:60});
  const lease=(await collector.claim(a,id,randomUUID()))!;
  const records=Array.from({length:50},(_,i)=>({
   ...record(String(89120000+i)),sourceCompany,internalOrderId:i===30?'':String(44008900+i),
  }));
  const testModule=await Test.createTestingModule({
   controllers:[DesktopAfterSalesCollectionController],
   providers:[{provide:DesktopAfterSalesCollectionService,useValue:collector}],
  }).compile();
  const app=testModule.createNestApplication();
  app.use((req:{user:AuthUser},_res:unknown,next:()=>void)=>{req.user=a;next();});
  app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));
  try{
   await app.listen(0,'127.0.0.1');
   const endpoint=`${await app.getUrl()}/desktop-after-sales-collection/${id}/commit`;
   const post=(batch:DesktopSaleSnapshot[])=>fetch(endpoint,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:lease.token,records:batch,page:1,completed:true}),
   });
   expect((await post([{...records[30],internalOrderId:'未知单号'}])).status).toBe(400);
   const response=await post(records);
   expect(response.status).toBe(201);
   expect(await response.json()).toMatchObject({received:50,completed:true,nextQueryAt:expect.any(String)});
  }finally{await app.close();}
  const [row]=(await svc.list(a,records[30].afterSaleId)).rows;
  expect(row.internalOrderId).toBe('');
  expect((await collector.list(a)).find(s=>s.id===id)?.collectedCount).toBe(50);
  const withOrder={...records[30],capturedAt:new Date().toISOString(),internalOrderId:'44009900'};
  const updated=await svc.refreshSource(a,row.id,withOrder);
  expect(updated.snapshot.internalOrderId).toBe(withOrder.internalOrderId);
  expect((await svc.list(a,withOrder.internalOrderId)).rows.map(r=>r.id)).toEqual([row.id]);
  const blankAgain={...withOrder,capturedAt:new Date().toISOString(),internalOrderId:'',fields:{...withOrder.fields,线上状态:'已确认'}};
  expect((await svc.refreshSource(a,row.id,blankAgain)).snapshot).toMatchObject({internalOrderId:withOrder.internalOrderId,fields:{线上状态:'已确认'}});
  await expect(svc.refreshSource(a,row.id,{...withOrder,internalOrderId:'44009901'})).rejects.toThrow(/当前售后不一致/);
 });
 it('历史已完结的售后依据处理日志归档，已有跟进时间仍保留',async()=>{
  const legacy=await svc.import(a,null,record('85118896'));
  const due=new Date('2030-01-02T03:04:00Z');
  await ds.query('UPDATE desktop_after_sales SET workspace_state=NULL,next_at=? WHERE company_id=? AND id=?',[due,a.companyId,legacy.id]);
  await ds.query("INSERT INTO desktop_after_sales_events(company_id,sale_id,kind,content_enc,actor_id) VALUES(?,?,'closed',?,?)",
   [a.companyId,legacy.id,crypto.encrypt('历史完结理由'),a.id]);
  expect((await svc.list(a,'85118896')).total).toBe(0);
  expect((await svc.list(a,'85118896',1,undefined,undefined,[],'closed')).rows.map(row=>row.id)).toEqual([legacy.id]);
  expect(await svc.detail(a,legacy.id)).toMatchObject({workspaceState:'closed',nextAt:due,closed:{reason:'历史完结理由'}});
 });
 it('跟进提醒到期发给跟进人或保存者，重复扫描不会再发，完结会取消提醒',async()=>{
  const team=await ds.query("INSERT INTO departments(company_id,name,status) VALUES(?,'客服部','active')",[a.companyId]);
  await ds.query('UPDATE users SET department_id=? WHERE company_id=? AND id IN (?,?)',[team.insertId,a.companyId,a.id,reader.id]);
  const assigned=await svc.import(a,null,record('85118891'));
  const self=await svc.import(a,null,record('85118892'));
  const cancelled=await svc.import(a,null,record('85118893'));
  const deadline=new Date('2030-01-02T03:04:00Z');
  const input={progress:'等待入库',note:'已联系仓库',nextAt:deadline.toISOString()};
  await svc.follow(a,assigned.id,{...input,version:assigned.version,ownerId:reader.id});
  await svc.follow(a,self.id,{...input,version:self.version});
  const saved=await svc.follow(a,cancelled.id,{...input,version:cancelled.version});
  await svc.close(a,cancelled.id,{...input,version:saved.version,reason:'已处理完毕'});
  const notices=()=>ds.query("SELECT user_id,title FROM notifications WHERE company_id=? AND title LIKE '%到了跟进时间' ORDER BY id",[a.companyId]);
  await svc.dispatchFollowReminders(new Date(deadline.getTime()-1000));
  expect(await notices()).toEqual([]);
  await Promise.all([svc.dispatchFollowReminders(deadline),svc.dispatchFollowReminders(deadline)]);
  expect(await notices()).toEqual([
   {user_id:reader.id,title:'售后 85118891 到了跟进时间'},
   {user_id:a.id,title:'售后 85118892 到了跟进时间'},
  ]);
  await expect(svc.assertAccess(reader,assigned.id,true)).resolves.toBeUndefined();
 });
 it('办理点击、协作通知和回复留存登录账号及操作时姓名',async()=>{
  const sale=await svc.import(a,null,record('85118895'));
  await expect(svc.recordActivity(other,sale.id,'open_case')).rejects.toThrow(/不存在/);
  await expect(svc.recordActivity(reader,sale.id,'open_shared')).rejects.toThrow(/协作权限/);
  await expect(svc.recordActivity(a,sale.id,'forged' as never)).rejects.toThrow(/未知售后操作/);
  const clicked=await svc.recordActivity(a,sale.id,'open_notice');
  expect(clicked).toMatchObject({kind:'activity',action:'打开通知表单',actorId:a.id,actorName:a.name});
  await collab.share(a,sale.id,[reader.id],'请查收退货',true);
  await svc.recordActivity(reader,sale.id,'open_shared');
  const replied=await svc.record(reader,sale.id,'仓库已签收');
  expect(replied.events[0]).toMatchObject({action:'回复协作记录',content:'仓库已签收',actorId:reader.id,actorName:reader.name});
  expect(replied.events.some(event=>'action' in event&&event.action==='发送协作通知'&&event.actorId===a.id&&event.content.includes(reader.name))).toBe(true);
  await ds.query('UPDATE users SET name=? WHERE company_id=? AND id=?',['后来改名',a.companyId,reader.id]);
  try{
   const latest=await svc.detail(a,sale.id);
   expect(latest.events[0]).toMatchObject({actorId:reader.id,actorName:reader.name});
   expect(latest.events.find(event=>event.id===clicked.id)?.createdAt.getTime()).toBe(clicked.createdAt.getTime());
  }finally{await ds.query('UPDATE users SET name=? WHERE company_id=? AND id=?',[reader.name,a.companyId,reader.id]);}
 });
 it('撕单通知整个仓储部并排队助手消息，仓储有权完结，只有新申请时间会重新进入待处理',async()=>{
  const input=record('85118894');
  const sale=await svc.import(a,null,input);
  await expect(svc.tear(a,sale.id,sale.version)).rejects.toThrow(/仓储部/);
  const warehouse=await ds.query("INSERT INTO departments(company_id,name,status) VALUES(?,'仓储部','active')",[a.companyId]);
  const child=await ds.query("INSERT INTO departments(company_id,parent_id,name,status) VALUES(?,?,'打包组','active')",[a.companyId,warehouse.insertId]);
  await ds.query('UPDATE users SET department_id=? WHERE company_id=? AND id=?',[warehouse.insertId,a.companyId,peer.id]);
  await ds.query('UPDATE users SET department_id=? WHERE company_id=? AND id=?',[child.insertId,a.companyId,reader.id]);
  await ds.query("INSERT INTO outbox_switches(company_id,channel,enabled) VALUES(?,'feishu',1)",[a.companyId]);
  await ds.query("INSERT INTO feishu_identities(company_id,user_id,tenant_key,app_id,open_id,oa_notifications) VALUES(?,?,'test','test','warehouse-reader',1)",[a.companyId,reader.id]);
  const sent=await svc.tear(a,sale.id,sale.version);
  expect(sent).toMatchObject({recipients:2,assistantQueued:1,archive:{workspaceState:'tear'}});
  expect((await svc.tear(a,sale.id,sale.version)).recipients).toBe(0);
  const notices=await ds.query("SELECT user_id FROM notifications WHERE company_id=? AND title='售后 85118894 待仓储部撕单' ORDER BY user_id",[a.companyId]);
  expect(notices).toEqual([{user_id:peer.id},{user_id:reader.id}]);
  const jobs=await ds.query("SELECT id FROM outbox_jobs WHERE company_id=? AND channel='feishu'",[a.companyId]);
  expect(jobs).toHaveLength(1);
  expect((await svc.list(a,'85118894')).total).toBe(0);
  expect((await svc.list(a,'85118894',1,undefined,undefined,[],'tear')).total).toBe(1);
  const finish={version:sent.archive.version,note:'仓储已处理撕单',reason:'订单已核对'};
  await expect(svc.closeTear(a,sale.id,finish)).rejects.toThrow(/只有仓储部/);
  await expect(svc.closeTear(other,sale.id,finish)).rejects.toThrow(/不存在/);
  const closed=await svc.closeTear(reader,sale.id,finish);
  expect(closed.workspaceState).toBe('closed');
  expect((await svc.list(a,'85118894',1,undefined,undefined,[],'tear')).total).toBe(0);
  expect((await svc.list(a,'85118894',1,undefined,undefined,[],'closed')).total).toBe(1);
  const newAt=new Date(closed.closed!.createdAt.getTime()+120000);
  const unchanged=await svc.refreshSource(a,sale.id,{...input,capturedAt:newAt.toISOString(),fields:{...input.fields,售后单状态:'确认'}});
  expect(unchanged.workspaceState).toBe('closed');
  const reopened=await svc.refreshSource(a,sale.id,{...input,capturedAt:newAt.toISOString(),fields:{...input.fields,申请时间:china(newAt)}});
  expect(reopened).toMatchObject({workspaceState:'open',closed:null});
  expect((await svc.list(a,'85118894')).total).toBe(1);
  expect(reopened.events.some(event=>event.kind==='closed'&&event.content===finish.reason)).toBe(true);
 });
 it('OA 完结与本次记录原子保存，重复提交及跨公司操作被拒绝，聚水潭变更继续归档',async()=>{
  const input=record('85118890');
  const original=await svc.import(a,null,input);
  const follow={version:original.version,progress:'已联系',nextAt:'2026-12-01T08:00:00Z',note:'买家确认处理结果',reason:'退款已核对'};
  await expect(svc.close(other,original.id,follow)).rejects.toThrow(/不存在/);
  await expect(svc.close(a,original.id,{...follow,reason:'  '})).rejects.toThrow(/完结理由/);
  await expect(svc.close(a,original.id,{...follow,version:original.version+1})).rejects.toThrow(/档案已被更新/);
  const closed=await svc.close(a,original.id,follow);
  expect(closed).toMatchObject({version:original.version+1,progress:'已完结',nextAt:null,closed:{reason:'退款已核对',actorName:a.name}});
  expect(closed.events.slice(0,2).map(event=>event.kind)).toEqual(['closed','follow']);
  expect(closed.events[1].content).toContain(follow.note);
  await expect(svc.close(a,original.id,follow)).rejects.toThrow(/已完结/);
  await expect(svc.follow(a,original.id,{...follow,version:closed.version})).rejects.toThrow(/已完结/);
  const updated=await svc.refreshSource(a,original.id,{...input,capturedAt:new Date(Date.now()+1000).toISOString(),
   fields:{...input.fields,线上状态:'已完成',原订单采购金额:'54.29'}});
  expect(updated.closed?.reason).toBe(follow.reason);
  const sourceEvent=(await svc.detail(peer,original.id)).events.find(event=>event.kind==='source_change');
  expect(sourceEvent).toMatchObject({changes:[{field:'线上状态',before:'等待买家退货',after:'已完成'}]});
  expect(JSON.stringify(sourceEvent)).not.toContain('54.29');
 });

});
describe('售后源变化与告警状态',()=>{
 it('聚水潭申请时间按北京时间读取，归档 ISO 时间保留其时区',()=>{
  const base={afterSaleId:'85118800',internalOrderId:'44008800',sourceCompany:'x',capturedAt:new Date().toISOString()};
  const read=(申请时间:string)=>applicationAt({...base,fields:{申请时间}})?.toISOString();
  expect(read('2026-11-06 14:00:00')).toBe('2026-11-06T06:00:00.000Z');
  expect(read('2026-11-06T06:00:00.000Z')).toBe('2026-11-06T06:00:00.000Z');
 });
 it('倒计时变化不冒充业务变更，清空标签是实际变更',()=>{
  const base={afterSaleId:'85118800',internalOrderId:'44008800',sourceCompany:'x',capturedAt:new Date().toISOString()};
  expect(sourceChanges({...base,fields:{线上状态:'待收货 还剩1天',售后标签:'标记'}},{...base,fields:{线上状态:'待收货 还剩12小时',售后标签:''}})).toEqual([{field:'售后标签',before:'标记',after:''}]);
 });
 it('客户端在线并不等于数据正常，超期、失败、关闭分别告警',()=>{
  const base={enabled:true,last_success_at:new Date(Date.now()-200000),last_failure_at:null,last_error_enc:null,lease_until:new Date(Date.now()+90000),interval_seconds:60};
  expect(collectionHealth(base)).toBe('stale');expect(collectionHealth({...base,last_error_enc:'encrypted'})).toBe('failed');expect(collectionHealth({...base,enabled:false})).toBe('stopped');
  expect(collectionHealth({...base,last_success_at:new Date(),last_client_seen_at:new Date(Date.now()-60000)})).toBe('healthy');
  expect(collectionHealth({...base,last_success_at:new Date(),last_client_seen_at:new Date(Date.now()-91000)})).toBe('waiting');
  expect(collectionHealth({...base,last_success_at:new Date(),last_client_seen_at:new Date()})).toBe('healthy');
 });

});
