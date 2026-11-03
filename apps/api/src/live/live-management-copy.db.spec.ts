import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Department, Position, User, Notification, FlowRun, OutboxSwitch, OutboxJob, WorkItem } from '../entities';
import { liveNotify, liveRecipientAllowed } from './live-notification-events';
import { writeNotification } from '../outbox/write-notification';
import { liveStartRecipients } from './live-start-notification';
import { liveManagementCopySender } from './live-management-notification-copy';
import { ConnectedFeishuSender } from '../outbox/feishu-sender';

const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('直播总经理通知同步人事（隔离MySQL）',()=>{
 let ds:DataSource,c:number,boss:number,hr:number,child:number,secondary:number,other:number,foreign:number,hrDept:number;
 const code=()=>randomBytes(8).toString('hex');
 beforeAll(async()=>{ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never);await ds.initialize();},30000);
 afterAll(async()=>{await ds?.destroy();});
 async function person(companyId:number,name:string,departmentId:number|null=null,isCompanyAdmin=false){return (await ds.manager.save(User,ds.manager.create(User,{companyId,name,departmentId,isCompanyAdmin,account:code(),passwordHash:'!fixture',status:'active',mustChangePassword:false}))).id;}
 async function department(companyId:number,name:string,parentId:number|null=null,status:'active'|'inactive'='active'){return (await ds.manager.save(Department,ds.manager.create(Department,{companyId,name,parentId,status}))).id;}
 beforeEach(async()=>{
  c=(await ds.manager.save(Company,ds.manager.create(Company,{code:code(),name:'抄送测试',status:'active'}))).id;
  const foreignCompany=(await ds.manager.save(Company,ds.manager.create(Company,{code:code(),name:'其他公司',status:'active'}))).id;
  hrDept=await department(c,'人事综合部');const childDept=await department(c,'人事小组',hrDept);const management=await department(c,'A总经理');
  boss=await person(c,'总经理',management,true);hr=await person(c,'人事',hrDept);child=await person(c,'子部门',childDept);secondary=await person(c,'兼岗');other=await person(c,'普通员工');foreign=await person(foreignCompany,'外公司人事',await department(foreignCompany,'人事部'));
  const position=await ds.manager.save(Position,ds.manager.create(Position,{companyId:c,name:'人事兼岗',departmentId:hrDept,status:'active'}));await ds.manager.update(User,{id:secondary},{extraPositionIds:[position.id]});
  const inactive=await person(c,'停用人事',hrDept);await ds.manager.update(User,{id:inactive},{status:'disabled'});
  await person(c,'停用部门',await department(c,'人事部',null,'inactive'));
 });
 const notes=()=>ds.manager.find(Notification,{where:{companyId:c}});
 it('所有直播事件同内容抄送，子部门/兼岗包含且去重，不发其他公司或停用人员',async()=>{
  expect((await liveStartRecipients(ds.manager,c,new Set(['人事综合部']))).sort()).toEqual([hr,child,secondary].sort());
  const notice={key:'custom-result:1',channel:'notice' as const,title:'场次审核结果',body:'相同正文'};
  await Promise.all([liveNotify(ds.manager,c,[boss,hr],notice),liveNotify(ds.manager,c,[boss],notice)]);
  expect((await notes()).map(n=>n.userId).sort()).toEqual([boss,hr,child,secondary].sort());
  expect((await notes()).every(n=>n.title===notice.title&&n.body===notice.body)).toBe(true);
  await liveNotify(ds.manager,c,[boss],notice);expect(await notes()).toHaveLength(4);
  expect(await ds.manager.count(WorkItem,{where:{companyId:c}})).toBe(0);
 });
 it('非直播消息不扩大接收范围，排班和两类直播审批仅抄送通知、不增加审批任务',async()=>{
  await writeNotification(ds.manager,{companyId:c,userId:boss,kind:'normal',title:'其他通知',body:null,link:null});expect(await notes()).toHaveLength(1);
  await writeNotification(ds.manager,{companyId:c,userId:boss,kind:'live_schedule',title:'排班调整',body:null,link:'/features/live-desk'},{resourceType:'live-schedule',resourceId:1,key:'changed:1:1',channel:'live'});
  for(const templateKey of ['sku-batch-apply','live-session-review','live-settlement']){
   const run=await ds.manager.save(FlowRun,ds.manager.create(FlowRun,{companyId:c,definitionId:1,templateKey,title:'流程',requesterId:boss,payload:{},stepsSnapshot:[],escalateUserIds:[],status:'running'}));
   await writeNotification(ds.manager,{companyId:c,userId:boss,kind:'pending',title:templateKey,body:null,link:`/workbench/pending?run=${run.id}`},{resourceType:'flow-run',resourceId:run.id,runId:run.id,channel:'flow',key:`run:${run.id}`});
   expect((await notes()).filter(n=>n.title===templateKey)).toHaveLength(templateKey==='sku-batch-apply'?1:4);
  }
  expect((await notes()).filter(n=>n.title==='排班调整')).toHaveLength(4);expect(await ds.manager.count(WorkItem,{where:{companyId:c}})).toBe(0);
 });
 it('人事已是直接收件人时两种发送顺序均只接收一份',async()=>{
  for(const order of [[boss,hr],[hr,boss]]) {
   const key='order:'+order[0];
   for(const userId of order)await writeNotification(ds.manager,{companyId:c,userId,kind:'live_schedule',title:key,body:null,link:'/features/live-desk'},{resourceType:'live-schedule',resourceId:1,key,channel:'live'});
   expect((await notes()).filter(n=>n.title===key&&n.userId===hr)).toHaveLength(1);
  }
 });
 it('开关关闭与事务回滚不生成抄送，未绑定仍有站内通知但不入飞书队列',async()=>{
  await ds.query("INSERT INTO live_notification_settings(company_id,enabled,business_recipients,system_recipients,activated_at,updated_by) VALUES(?,0,'[]','[]',CURRENT_TIMESTAMP,1)",[c]);
  await liveNotify(ds.manager,c,[boss],{key:'off',channel:'live',title:'关闭',body:''});expect(await notes()).toHaveLength(0);
  await ds.query('DELETE FROM live_notification_settings WHERE company_id=?',[c]);
  await expect(ds.transaction(async em=>{await liveNotify(em,c,[boss],{key:'rollback',channel:'live',title:'回滚',body:''});throw new Error('fixture rollback');})).rejects.toThrow('fixture rollback');expect(await notes()).toHaveLength(0);
  await liveNotify(ds.manager,c,[boss],{key:'oa-only',channel:'live',title:'站内',body:''});expect(await notes()).toHaveLength(4);expect(await ds.manager.count(OutboxJob,{where:{companyId:c}})).toBe(0);
 });
 it('日报和接口提醒保留原通道，飞书发送复核原接收配置与双方部门，权限只授予通知而非页面',async()=>{
  await ds.query('INSERT INTO live_notification_settings(company_id,enabled,digest_enabled,business_recipients,system_recipients,activated_at,updated_by) VALUES(?,1,1,?,?,CURRENT_TIMESTAMP,1)',[c,JSON.stringify([boss]),JSON.stringify([boss])]);
  await ds.manager.save(OutboxSwitch,ds.manager.create(OutboxSwitch,{companyId:c,channel:'feishu',enabled:true,updatedBy:boss}));
  await ds.query("INSERT INTO feishu_identities(company_id,user_id,tenant_key,app_id,open_id,oa_notifications) VALUES(?,?,'fixture-tenant','fixture-app','fixture-hr',1)",[c,hr]);
  await liveNotify(ds.manager,c,[boss],{key:'digest:2026-11-03',channel:'business',title:'日报',body:'日报正文'});
  const job=await ds.manager.findOneByOrFail(OutboxJob,{companyId:c});const payload=job.payloadJson as never;
  expect(job.payloadJson).toMatchObject({channel:'business',userId:hr,liveManagementCopySource:expect.any(Number)});
  expect(await liveManagementCopySender(ds.manager,c,payload)).toBe(boss);
  const send=jest.fn();const sender=new ConnectedFeishuSender({ds,read:async()=>({enabled:true,tenantKey:'fixture-tenant',appId:'fixture-app',appSecret:'fixture-only',origin:'https://example.test',channels:[{key:'business',enabled:true,inheritsMainApp:true},{key:'system',enabled:true,inheritsMainApp:true}]})} as never,{send} as never);
  await sender.send({companyId:c,idempotencyKey:'fixture',notice:payload});expect(send).toHaveBeenCalledTimes(1);
  expect(await liveRecipientAllowed(ds.manager,c,hr,'features.live.view')).toBe(false);
  await ds.query("INSERT INTO live_notification_health(company_id,health_key,failures,first_failed_at,updated_at) VALUES(?,'fixture-health',3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[c]);
  await liveNotify(ds.manager,c,[boss],{key:'health:fixture-health:2026-11-03',channel:'system',title:'接口异常',body:'异常正文'});
  const [raw]=await ds.query("SELECT payload_json FROM outbox_jobs WHERE company_id=? AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.channel'))='system'",[c]);
  const systemNotice=typeof raw.payload_json==='string'?JSON.parse(raw.payload_json):raw.payload_json;
  expect(systemNotice).toMatchObject({userId:hr,channel:'system',liveManagementCopySource:expect.any(Number)});
  await sender.send({companyId:c,idempotencyKey:'system',notice:systemNotice});expect(send).toHaveBeenCalledTimes(2);
  await ds.query("UPDATE live_notification_health SET failures=0 WHERE company_id=?",[c]);await sender.send({companyId:c,idempotencyKey:'recovered',notice:systemNotice});expect(send).toHaveBeenCalledTimes(2);
  await ds.query("UPDATE live_notification_settings SET business_recipients='[]' WHERE company_id=?",[c]);await sender.send({companyId:c,idempotencyKey:'removed',notice:payload});expect(send).toHaveBeenCalledTimes(2);
  await ds.manager.update(User,{id:hr},{departmentId:null});expect(await liveManagementCopySender(ds.manager,c,payload)).toBeNull();
  await ds.manager.update(User,{id:hr},{departmentId:hrDept});await ds.manager.update(User,{id:boss},{departmentId:null});expect(await liveManagementCopySender(ds.manager,c,payload)).toBeNull();
  expect(await liveManagementCopySender(ds.manager,c,{...job.payloadJson,userId:foreign} as never)).toBeNull();
 });
});
