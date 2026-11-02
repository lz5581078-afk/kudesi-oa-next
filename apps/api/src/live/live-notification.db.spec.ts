import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { randomBytes } from 'crypto';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User, Notification, OutboxSwitch, UserPermissionOverride, ResourceRecord } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { ExternalConfigService } from '../integrations/external-config.service';
import { LiveNotificationService } from './live-notification.service';
import { liveNotify, liveHandover, liveSessionResult } from './live-notification-events';
import { liveNoticeValid } from './live-notification-validity';
import { liveClock } from './live-core';

const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('直播通知（隔离 MySQL）',()=>{
  let ds:DataSource,svc:LiveNotificationService,companyId:number,foreignCompany:number,admin:AuthUser,anchor:number,control:number,owner:number,foreign:number;
  const original=liveClock.now;
  const clock=(s:string)=>{liveClock.now=()=>new Date(s.replace(' ','T')+'+08:00');};
  const notices=()=>ds.manager.find(Notification,{where:{companyId}});
  const settings=(extra:Record<string,unknown>={})=>({enabled:true,digestEnabled:false,digestHour:9,businessRecipients:[admin.id],systemRecipients:[admin.id],...extra});
  async function person(c:number,name:string,isCompanyAdmin=false){return (await ds.manager.save(User,ds.manager.create(User,{companyId:c,name,account:randomBytes(5).toString('hex'),passwordHash:'x',status:'active',mustChangePassword:false,isCompanyAdmin}))).id;}
  async function schedule(start='2026-11-02 10:00:00',end='2026-11-02 11:00:00'){
    return Number((await ds.query(`INSERT INTO live_schedules(company_id,room_id,room_name,schedule_date,start_at,end_at,anchor_user_id,control_user_id,operator_user_id,douyin_account_id,douyin_account_name,created_by) VALUES(?,1,'测试间','2026-11-02',?,?,?,?,?,1,'测试号',?)`,[companyId,start,end,anchor,control,anchor,admin.id])).insertId);
  }
  async function session(status='pending_report',scheduleId:number|null=null,day='2026-11-02'){
    return Number((await ds.query(`INSERT INTO live_sessions(company_id,schedule_id,room_id,room_name,session_date,start_at,end_at,status,anchor_user_id,control_user_id,operator_user_id,douyin_account_id,douyin_account_name,started_by,started_role) VALUES(?,?,1,'测试间',?,?,?, ?,?,?,?,1,'测试号',?,'anchor')`,[companyId,scheduleId,day,day+' 10:00:00',status==='live'?null:day+' 11:00:00',status,anchor,control,anchor,anchor])).insertId);
  }
  async function report(sessionId:number,role:string,userId:number){await ds.query("INSERT INTO live_session_reports(company_id,session_id,role,reporter_user_id,end_at,sales_cents,ad_spend_cents) VALUES(?,?,?,?,'2026-11-02 11:00:00',10000,1000)",[companyId,sessionId,role,userId]);}
  beforeAll(async()=>{
    ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never);await ds.initialize();
    svc=new LiveNotificationService(ds,{read:async()=>null} as unknown as ExternalConfigService);
    companyId=(await ds.manager.save(Company,ds.manager.create(Company,{code:'ln'+randomBytes(4).toString('hex'),name:'通知公司',status:'active'}))).id;
    foreignCompany=(await ds.manager.save(Company,ds.manager.create(Company,{code:'ln'+randomBytes(4).toString('hex'),name:'其他公司',status:'active'}))).id;
    admin={id:await person(companyId,'管理员',true),companyId,name:'管理员',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    anchor=await person(companyId,'主播');control=await person(companyId,'中控');owner=await person(companyId,'负责人');foreign=await person(foreignCompany,'外公司',true);
  },30000);
  beforeEach(async()=>{
    clock('2026-11-02 09:00:00');
    for(const table of ['live_notification_events','live_notification_settings','live_notification_health','live_session_reports','live_commission_records','live_schedules','live_sessions','live_room_settings','outbox_jobs','notifications','feishu_identities','outbox_switches'])await ds.query(`DELETE FROM ${table} WHERE company_id=?`,[companyId]);
    await svc.save(admin,settings());
    await ds.query('INSERT INTO live_room_settings(company_id,room_id,owner_user_id,updated_by) VALUES(?,1,?,?)',[companyId,owner,admin.id]);
  });
  afterAll(async()=>{liveClock.now=original;await ds?.destroy();});

  it('同一事件并发不重复；跨公司和停用人员不收，事务回滚不留通知',async()=>{
    const notice={key:'result:1',channel:'notice' as const,title:'结果',body:'查看本人明细'};
    await Promise.all([liveNotify(ds.manager,companyId,[anchor,anchor,foreign],notice),liveNotify(ds.manager,companyId,[anchor],notice)]);
    expect((await notices()).map(n=>n.userId)).toEqual([anchor]);
    await expect(ds.transaction(async em=>{await liveNotify(em,companyId,[control],{...notice,key:'rollback'});throw new Error('rollback');})).rejects.toThrow('rollback');
    expect((await notices()).length).toBe(1);
    await ds.query("UPDATE users SET status='inactive' WHERE company_id=? AND id=?",[companyId,control]);
    await liveNotify(ds.manager,companyId,[control],{...notice,key:'inactive'});expect((await notices()).length).toBe(1);
    await ds.query("UPDATE users SET status='active' WHERE company_id=? AND id=?",[companyId,control]);
  });
  it('拒绝无权限、跨公司日报收件人；权限撤销后已入队日报失效',async()=>{
    await expect(svc.save(admin,settings({businessRecipients:[foreign]}))).rejects.toThrow('接收人');
    await expect(svc.save(admin,settings({businessRecipients:[anchor]}))).rejects.toThrow('接收人');
    await expect(svc.save(admin,settings({digestEnabled:true,businessRecipients:[]}))).rejects.toThrow('接收人');
    await ds.manager.save(UserPermissionOverride,ds.manager.create(UserPermissionOverride,{userId:anchor,permission:'features.live.view',effect:'allow'}));
    await svc.save(admin,settings({digestEnabled:true,businessRecipients:[anchor]}));
    expect(await liveNoticeValid(ds.manager,companyId,anchor,'digest:2026-11-01')).toBe(true);
    await ds.query("UPDATE user_permission_overrides SET effect='deny' WHERE user_id=? AND permission='features.live.view'",[anchor]);
    expect(await liveNoticeValid(ds.manager,companyId,anchor,'digest:2026-11-01')).toBe(false);
    await ds.query('DELETE FROM user_permission_overrides WHERE user_id=?',[anchor]);
  });
  it('未开播催本场人员、30分钟升级负责人；改期或开播使旧队列失效',async()=>{
    const id=await schedule();clock('2026-11-02 10:06:00');await svc.scan();await svc.scan();
    expect((await notices()).map(n=>n.userId).sort()).toEqual([anchor,control].sort());
    clock('2026-11-02 10:31:00');await svc.scan();expect((await notices()).filter(n=>n.userId===owner)).toHaveLength(1);
    expect(await liveNoticeValid(ds.manager,companyId,anchor,`late:${id}:1:crew`)).toBe(true);
    await ds.query("UPDATE live_schedules SET status='live' WHERE company_id=? AND id=?",[companyId,id]);
    expect(await liveNoticeValid(ds.manager,companyId,anchor,`late:${id}:1:crew`)).toBe(false);
  });
  it('超过预计下播催办；临时场次没有预计下播时间不误报',async()=>{
    const sch=await schedule();await ds.query("UPDATE live_schedules SET status='live' WHERE company_id=? AND id=?",[companyId,sch]);
    const id=await session('live',sch);clock('2026-11-02 11:11:00');await svc.scan();expect((await notices()).every(n=>n.title==='已超过预计下播时间')).toBe(true);expect((await notices())).toHaveLength(2);
    await ds.query("UPDATE live_sessions SET status='pending_report',end_at='2026-11-02 11:11:00' WHERE company_id=? AND id=?",[companyId,id]);
    expect(await liveNoticeValid(ds.manager,companyId,anchor,`overrun:${id}:crew`)).toBe(false);
  });
  it('只催缺报人；齐报后催提交，提交后停止；交接仅发下一场且去重',async()=>{
    const id=await session();await report(id,'anchor',anchor);clock('2026-11-02 11:31:00');await svc.scan();
    expect((await notices()).map(n=>n.userId)).toEqual([control]);
    await report(id,'control',control);await svc.scan();
    expect((await notices()).filter(n=>n.title.includes('提交审核'))).toHaveLength(2);
    expect(await liveNoticeValid(ds.manager,companyId,control,`report:${id}:missing:crew`)).toBe(false);
    await ds.query("UPDATE live_sessions SET status='submitted' WHERE company_id=? AND id=?",[companyId,id]);
    expect(await liveNoticeValid(ds.manager,companyId,anchor,`report:${id}:submit:crew`)).toBe(false);
    const next=await schedule('2026-11-02 12:00:00','2026-11-02 13:00:00');
    await liveHandover(ds.manager,companyId,id);await liveHandover(ds.manager,companyId,id);
    expect((await notices()).filter(n=>n.title.includes('交接'))).toHaveLength(2);
    await ds.query("UPDATE live_schedules SET status='cancelled' WHERE company_id=? AND id=?",[companyId,next]);
    expect(await liveNoticeValid(ds.manager,companyId,anchor,`handover:${id}:${next}:1`)).toBe(false);
  });
  it('日报按北京时间、场次去重，不把多个角色的销售和投流重复加算',async()=>{
    await svc.save(admin,settings({digestEnabled:true}));const id=await session('approved',null,'2026-11-01');
    await ds.query('UPDATE live_sessions SET final_sales_cents=20000 WHERE company_id=? AND id=?',[companyId,id]);
    for(const [role,uid] of [['anchor',anchor],['control',control]] as const)await ds.query(`INSERT INTO live_commission_records(company_id,session_id,user_id,role,session_date,final_sales_cents,ad_spend_cents,rate_units,amount_cents,rule_version_id,rule_snapshot,approved_by,approved_at) VALUES(?,?,?,?,'2026-11-01',20000,2000,1,777,1,'{}',?,'2026-11-01 12:00:00')`,[companyId,id,uid,role,admin.id]);
    clock('2026-11-02 08:59:00');await svc.scan();expect(await notices()).toHaveLength(0);
    clock('2026-11-02 09:00:00');await svc.scan();await svc.scan();
    const [n]=await notices();expect((await notices())).toHaveLength(1);expect(n.userId).toBe(admin.id);expect(n.body).toContain('200.00 元');expect(n.body).toContain('20.00 元');expect(n.body).toContain('10.00');expect(n.body).not.toContain('7.77');
  });
  it('接口连续失败达到次数和时长才通知；恢复后积压消息失效',async()=>{
    clock('2026-11-02 10:00:00');await svc.health(companyId,'orders:123',false);await svc.health(companyId,'orders:123',false);expect(await notices()).toHaveLength(0);
    clock('2026-11-02 10:06:00');await svc.health(companyId,'orders:123',false);await svc.health(companyId,'orders:123',false);expect(await notices()).toHaveLength(1);
    expect(await liveNoticeValid(ds.manager,companyId,admin.id,'health:orders:123:2026-11-02')).toBe(true);
    await svc.health(companyId,'orders:123',true);expect(await liveNoticeValid(ds.manager,companyId,admin.id,'health:orders:123:2026-11-02')).toBe(false);
  });
  it('到期授权按店铺、日期和阶段去重；永久与未知日期不误报，续期使旧提醒失效',async()=>{
    const make=async(name:string,data:Record<string,unknown>)=>(await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId,type:'stores',title:name,status:'normal',data,searchText:name}))).id;
    const id=await make('快到期店铺',{jushuitanShopId:'12',jushuitanExpiryStatus:'dated',jushuitanExpireAt:'2026-11-07'});
    const permanent=await make('永久店铺',{jushuitanShopId:'13',jushuitanExpiryStatus:'permanent',jushuitanExpireAt:'2020-01-01'});
    const unknown=await make('未知期限',{jushuitanShopId:'14',jushuitanExpiryStatus:'unknown'});
    await svc.scan();await svc.scan();expect((await notices()).filter(n=>n.title.includes('授权'))).toHaveLength(1);
    expect(await liveNoticeValid(ds.manager,companyId,admin.id,`expiry:${id}:2026-11-07:soon`)).toBe(true);
    await ds.query("UPDATE resource_records SET data=JSON_SET(data,'$.jushuitanExpireAt','2027-01-01') WHERE company_id=? AND id=?",[companyId,id]);
    expect(await liveNoticeValid(ds.manager,companyId,admin.id,`expiry:${id}:2026-11-07:soon`)).toBe(false);
    for(const store of [id,permanent,unknown])await ds.manager.delete(ResourceRecord,{companyId,id:store});
  });
  it('飞书出站遵循总开关和绑定；停用新通知后不再产生OA或飞书消息',async()=>{
    await ds.manager.save(OutboxSwitch,ds.manager.create(OutboxSwitch,{companyId,channel:'feishu',enabled:true,updatedBy:admin.id}));
    await ds.query("INSERT INTO feishu_identities(company_id,user_id,tenant_key,app_id,open_id,oa_notifications) VALUES(?,?,'t','a','o',1)",[companyId,anchor]);
    await liveSessionResult(ds.manager,companyId,await session(),'private-result','本人结果',control);
    const [job]=await ds.query("SELECT payload_json FROM outbox_jobs WHERE company_id=?",[companyId]);expect(job).toBeTruthy();
    const payload=typeof job.payload_json==='string'?JSON.parse(job.payload_json):job.payload_json;expect(payload.channel).toBe('notice');expect(payload.userId).toBe(anchor);
    await svc.save(admin,settings({enabled:false}));await liveNotify(ds.manager,companyId,[anchor],{key:'disabled',channel:'live',title:'停用',body:'停用'});
    expect((await notices()).some(n=>n.title==='停用')).toBe(false);expect(await liveNoticeValid(ds.manager,companyId,anchor,'private-result')).toBe(false);
  });
});
