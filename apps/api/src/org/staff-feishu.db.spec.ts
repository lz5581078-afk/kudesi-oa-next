import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, Notification, OutboxJob, OutboxSwitch, User } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { ExternalConfigService, FeishuConfig } from '../integrations/external-config.service';
import { ConnectedFeishuSender } from '../outbox/feishu-sender';
import { FeishuNoticeService } from '../outbox/feishu-notice.service';
import { StaffFeishuService } from './staff-feishu.service';

const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('人员飞书状态和单人测试通知（隔离 MySQL）',()=>{
  let ds:DataSource,service:StaffFeishuService,external:ExternalConfigService,companyId:number,otherCompany:number;
  let actor:AuthUser,viewer:AuthUser,regular:number,partTime:number,temp:number,foreign:number;
  let cfg:FeishuConfig|null;
  const api={send:jest.fn(async()=>{})};
  const notices=()=>ds.manager.find(Notification,{where:{companyId}});
  const jobs=()=>ds.manager.find(OutboxJob,{where:{companyId}});
  const binding=(id:number,extra:{app?:string;tenant?:string;notify?:number}={})=>ds.query('INSERT INTO feishu_identities(company_id,user_id,app_id,tenant_key,open_id,union_id,oa_notifications) VALUES(?,?,?,?,?,?,?)',[companyId,id,extra.app??'app',extra.tenant??'tenant','ou_'+id,'un_'+id,extra.notify??1]);
  const employee=async(c:number,type='regular')=>(await ds.manager.save(User,ds.manager.create(User,{companyId:c,account:randomBytes(8).toString('hex'),passwordHash:'x',name:type,status:'active',employmentType:type} as never))).id;
  beforeAll(async()=>{
    ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never);await ds.initialize();
    companyId=(await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'本公司',status:'active'}))).id;
    otherCompany=(await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'其他公司',status:'active'}))).id;
    actor={id:await employee(companyId),companyId,name:'人事',permissions:{isCompanyAdmin:false,allow:['org.staff.view','org.staff.edit'],deny:[]}};
    viewer={...actor,id:await employee(companyId),permissions:{isCompanyAdmin:false,allow:['org.staff.view'],deny:[]}};
    regular=await employee(companyId);partTime=await employee(companyId,'part_time');temp=await employee(companyId,'temp');foreign=await employee(otherCompany);
    external={ds,read:async()=>cfg} as unknown as ExternalConfigService;
    service=new StaffFeishuService(ds,external);
  },30000);
  beforeEach(async()=>{
    cfg={appId:'app',appSecret:'synthetic-app-secret',tenantKey:'tenant',enabled:true,origin:'https://oa.example',channels:[]};api.send.mockClear();
    for(const table of ['notifications','outbox_jobs','outbox_switches','feishu_identities'])await ds.query(`DELETE FROM ${table} WHERE company_id=?`,[companyId]);
    await ds.query("UPDATE users SET status='active' WHERE company_id=?",[companyId]);
    await ds.query("UPDATE companies SET status='active' WHERE id=?",[companyId]);
    await ds.manager.save(OutboxSwitch,ds.manager.create(OutboxSwitch,{companyId,channel:'feishu',enabled:true}));
    await binding(regular);await binding(partTime);
  });
  afterAll(async()=>{await ds?.destroy();});
  it('正式、兼职、临时人员统一返回；绑定必须匹配公司当前应用和租户，不返回飞书身份或密钥',async()=>{
    await binding(temp,{app:'old-app'});
    const result=await service.statuses(actor);
    expect(result.rows.find(r=>r.userId===regular)).toMatchObject({bound:true,canTest:true});
    expect(result.rows.find(r=>r.userId===partTime)).toMatchObject({bound:true,canTest:true});
    expect(result.rows.find(r=>r.userId===temp)).toMatchObject({bound:false,canTest:false});
    expect(result.rows.some(r=>r.userId===foreign)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-app-secret|ou_|un_|open_id|appSecret/);
  });
  it('旧租户、未开通知、停用和配置缺失均有准确状态；未知配置不冒充未绑定',async()=>{
    await ds.query("DELETE FROM feishu_identities WHERE company_id=? AND user_id=?",[companyId,partTime]);await binding(partTime,{tenant:'old-tenant'});
    await ds.query('UPDATE feishu_identities SET oa_notifications=0 WHERE company_id=? AND user_id=?',[companyId,regular]);
    let rows=(await service.statuses(actor)).rows;
    expect(rows.find(r=>r.userId===regular)).toMatchObject({bound:true,notificationsEnabled:false,canTest:false});
    expect(rows.find(r=>r.userId===partTime)?.bound).toBe(false);
    cfg=null;rows=(await service.statuses(actor)).rows;expect(rows.every(r=>r.bound===null&&!r.canTest)).toBe(true);
  });
  it('同一请求并发重试仅一条OA通知、一个出站任务和一条审计，返回入队而非发送成功',async()=>{
    const request=randomUUID();
    const result=await Promise.all([service.sendTest(actor,partTime,request),service.sendTest(actor,partTime,request)]);
    expect(result[0]).toMatchObject({userId:partTime,status:'pending',jobId:result[1].jobId});
    expect(await notices()).toHaveLength(1);expect(await jobs()).toHaveLength(1);
    const [job]=await jobs();expect(job.payloadJson).toMatchObject({userId:partTime,channel:'notice',kind:'staff-feishu-test'});expect(job.createdBy).toBe(actor.id);
    expect(await ds.manager.count(AuditLog,{where:{companyId,action:'staff.feishu.test',resourceId:String(partTime)}})).toBe(1);
    await expect(service.sendTest(actor,partTime,randomUUID())).rejects.toMatchObject({status:429});
  });
  it('无修改权限、跨公司、未绑定、停用人员均拒绝，失败不留OA通知或队列',async()=>{
    await expect(service.sendTest(viewer,regular,randomUUID())).rejects.toThrow('权限');
    await expect(service.sendTest(actor,foreign,randomUUID())).rejects.toThrow('不存在');
    await expect(service.sendTest(actor,0,randomUUID())).rejects.toThrow('不存在');
    await expect(service.sendTest(actor,temp,randomUUID())).rejects.toThrow('尚未绑定');
    await ds.query("UPDATE users SET status='disabled' WHERE company_id=? AND id=?",[companyId,partTime]);
    await expect(service.sendTest(actor,partTime,randomUUID())).rejects.toThrow('停用');
    expect(await jobs()).toHaveLength(0);expect(await notices()).toHaveLength(0);
  });
  it('通知总开关、助手通道和员工通知开关不允许测试绕过，也不自动开启',async()=>{
    await ds.manager.update(OutboxSwitch,{companyId,channel:'feishu'},{enabled:false});
    await expect(service.sendTest(actor,regular,randomUUID())).rejects.toThrow('总开关');
    await ds.manager.update(OutboxSwitch,{companyId,channel:'feishu'},{enabled:true});
    cfg!.channels=[{key:'notice',appId:'',appSecret:'',enabled:false,inheritsMainApp:true,recipientUserIds:[]}];
    await expect(service.sendTest(actor,regular,randomUUID())).rejects.toThrow('通道');
    cfg!.channels=[];await ds.query('UPDATE feishu_identities SET oa_notifications=0 WHERE company_id=? AND user_id=?',[companyId,regular]);
    await expect(service.sendTest(actor,regular,randomUUID())).rejects.toThrow('开启');expect(await jobs()).toHaveLength(0);
  });
  it('状态仅能查本人发起的本公司指定员工测试；关闭发送开关显示暂停',async()=>{
    const r=await service.sendTest(actor,regular,randomUUID());
    await expect(service.testStatus({...actor,companyId:otherCompany},regular,r.jobId)).rejects.toThrow('不存在');
    await expect(service.testStatus({...actor,id:viewer.id},regular,r.jobId)).rejects.toThrow('不存在');
    await expect(service.testStatus(actor,partTime,r.jobId)).rejects.toThrow('不存在');
    await ds.manager.update(OutboxSwitch,{companyId,channel:'feishu'},{enabled:false});expect((await service.testStatus(actor,regular,r.jobId)).status).toBe('paused');
  });
  it('真实发送器替身确认后才显示成功，重复运行worker不重复发，消息仅发给指定兼职员工',async()=>{
    const r=await service.sendTest(actor,partTime,randomUUID());
    const sender=new ConnectedFeishuSender(external,api as never),worker=new FeishuNoticeService(ds,sender);
    await worker.processCompany(companyId);await worker.processCompany(companyId);
    expect(api.send).toHaveBeenCalledTimes(1);expect(api.send.mock.calls[0]).toEqual(expect.arrayContaining(['ou_'+partTime,'open_id']));
    expect((await service.testStatus(actor,partTime,r.jobId)).status).toBe('done');
  });
  it('一次投递使用同一份公司配置，绑定校验与实际应用不分离',async()=>{
    await service.sendTest(actor,regular,randomUUID());const [job]=await jobs();
    const read=jest.spyOn(external,'read').mockResolvedValueOnce(cfg as never).mockResolvedValueOnce({...cfg!,appId:'another-app'} as never);
    try {
      await new ConnectedFeishuSender(external,api as never).send({companyId,idempotencyKey:job.idempotencyKey,notice:job.payloadJson as never});
      expect(read).toHaveBeenCalledTimes(1);expect(api.send.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({appId:'app'}),'ou_'+regular,'open_id']));
    } finally {read.mockRestore();}
  });
  it('发送失败只尝试一次，不反复推送测试消息；前端状态不声称本人已读',async()=>{
    const r=await service.sendTest(actor,regular,randomUUID());api.send.mockRejectedValueOnce(new Error('测试接口拒绝'));
    const worker=new FeishuNoticeService(ds,new ConnectedFeishuSender(external,api as never));await worker.processCompany(companyId);await worker.processCompany(companyId);
    expect(api.send).toHaveBeenCalledTimes(1);expect((await service.testStatus(actor,regular,r.jobId)).status).toBe('failed');
  });
  it.each(['binding','disabled','expired'])('排队后%s变化时不发出，并停止自动重试',async(mode)=>{
    const r=await service.sendTest(actor,regular,randomUUID());
    if(mode==='binding')await ds.query('UPDATE feishu_identities SET oa_notifications=0 WHERE company_id=? AND user_id=?',[companyId,regular]);
    if(mode==='disabled')await ds.query("UPDATE users SET status='disabled' WHERE company_id=? AND id=?",[companyId,regular]);
    if(mode==='expired'){const [job]=await jobs();await ds.manager.update(OutboxJob,{id:job.id},{payloadJson:{...job.payloadJson,expiresAt:'2020-01-01T00:00:00Z'}});}
    const worker=new FeishuNoticeService(ds,new ConnectedFeishuSender(external,api as never));await worker.processCompany(companyId);
    expect(api.send).not.toHaveBeenCalled();expect((await service.testStatus(actor,regular,r.jobId)).status).toBe('failed');
  });
});
