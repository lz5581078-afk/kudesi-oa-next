import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createChecker } from '@kudesi/shared';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, OutboxJob, OutboxSwitch } from '../entities';
import { ExternalConfigService, FeishuConfig } from '../integrations/external-config.service';
import { writeNotification } from '../outbox/write-notification';

export const STAFF_TEST_TITLE = 'OA 飞书通知测试';
export const STAFF_TEST_BODY = '这是一条 OA 测试通知，用于确认 OA 与你绑定的飞书账号之间的消息通道是否正常，无需办理业务。';
export interface StaffFeishuStatus {
  userId:number; bound:boolean|null; boundAt:string|null; notificationsEnabled:boolean|null; canTest:boolean; testBlockedReason:string|null;
}
const RESOURCE = 'staff-feishu-test';
@Injectable()
export class StaffFeishuService {
  constructor(@InjectDataSource() private readonly ds:DataSource, private readonly config:ExternalConfigService) {}
  private permission(actor:AuthUser,edit=false) {
    const can=createChecker(actor.permissions);
    if(!can('org.staff.view')||edit&&!can('org.staff.edit'))throw new ForbiddenException('没有人员通知管理权限');
  }
  private async load(em:EntityManager,companyId:number,userId?:number):Promise<StaffFeishuStatus[]> {
    const filtered=userId!==undefined;
    const users=await em.query(`SELECT id,status FROM users WHERE company_id=?${filtered?' AND id=?':''}`,[companyId,...(filtered?[userId]:[])]);
    let cfg:FeishuConfig|null=null, unavailable=false;
    try {cfg=await this.config.read<FeishuConfig>(companyId,'feishu');} catch {unavailable=true;}
    const configured=!!cfg?.appId&&!!cfg.tenantKey;
    const bindings=configured?await em.query(`SELECT user_id,open_id,union_id,oa_notifications,DATE_FORMAT(bound_at,'%Y-%m-%d %H:%i:%s') bound_at
      FROM feishu_identities WHERE company_id=? AND app_id=? AND tenant_key=?`,[companyId,cfg!.appId,cfg!.tenantKey]):[];
    const byId=new Map<number,Record<string,any>>(bindings.map((b:Record<string,any>)=>[Number(b.user_id),b]));
    const sw=await em.findOne(OutboxSwitch,{where:{companyId,channel:'feishu'}});
    const [company]=await em.query('SELECT status FROM companies WHERE id=?',[companyId]);
    const channel=cfg?.channels?.find(c=>c.key==='notice');
    const app=channel&&!channel.inheritsMainApp?channel:cfg;
    return users.map((u:Record<string,any>)=>{
      const b=byId.get(Number(u.id)),bound=configured?!!b:null;
      let reason:string|null=null;
      if(u.status!=='active')reason='员工已停用';
      else if(company?.status!=='active')reason='公司已停用';
      else if(unavailable)reason='公司飞书配置暂不可用';
      else if(!configured)reason='公司尚未配置飞书授权';
      else if(!bound)reason='尚未绑定本人飞书';
      else if(Number(b?.oa_notifications)!==1)reason='员工尚未开启 OA 飞书通知';
      else if(!cfg?.enabled)reason='公司飞书授权已关闭';
      else if(!sw?.enabled)reason='公司飞书通知总开关已关闭';
      else if(channel&&!channel.enabled)reason='通知助手通道已关闭';
      else if(!app?.appId||!app.appSecret||!cfg?.appSecret)reason='通知助手应用尚未配置完整';
      else if(!b?.open_id||app.appId!==cfg.appId&&!b?.union_id)reason='此助手需要完整飞书身份，请本人重新授权';
      return {userId:Number(u.id),bound,boundAt:b?.bound_at??null,notificationsEnabled:bound?Number(b?.oa_notifications)===1:null,canTest:!reason,testBlockedReason:reason};
    });
  }
  async statuses(actor:AuthUser) {this.permission(actor);return {rows:await this.load(this.ds.manager,actor.companyId)};}
  private key(actor:AuthUser,id:number,requestId:string){return `feishu:staff-test:${actor.id}:${requestId}:${id}`;}
  async sendTest(actor:AuthUser,id:number,requestId:string) {
    this.permission(actor,true);
    const jobId=await this.ds.transaction(async em=>{
      await em.query('SELECT id FROM companies WHERE id=? FOR UPDATE',[actor.companyId]);
      const key=this.key(actor,id,requestId);
      const existing=await em.findOne(OutboxJob,{where:{companyId:actor.companyId,idempotencyKey:key,resourceType:RESOURCE,resourceId:id,createdBy:actor.id}});
      if(existing)return existing.id;
      const [state]=await this.load(em,actor.companyId,id);
      if(!state)throw new NotFoundException('员工不存在');
      if(!state.canTest)throw new BadRequestException(state.testBlockedReason!);
      const recent=await em.query("SELECT id FROM outbox_jobs WHERE company_id=? AND resource_type=? AND resource_id=? AND created_at>DATE_SUB(NOW(),INTERVAL 60 SECOND) LIMIT 1",[actor.companyId,RESOURCE,id]);
      if(recent.length)throw new HttpException('该员工刚收到测试请求，请等待一分钟后再试',429);
      const expiresAt=new Date(Date.now()+10*60_000).toISOString();
      const saved=await writeNotification(em,{companyId:actor.companyId,userId:id,kind:RESOURCE,title:STAFF_TEST_TITLE,body:STAFF_TEST_BODY,link:'/'},
        {key:`staff-test:${actor.id}:${requestId}`,channel:'notice',resourceType:RESOURCE,resourceId:id,kind:RESOURCE,expiresAt});
      if(!saved.feishuQueued)throw new BadRequestException('飞书通知条件已变化，请刷新绑定状态后重试');
      const job=await em.findOneByOrFail(OutboxJob,{companyId:actor.companyId,idempotencyKey:key});
      await em.update(OutboxJob,{id:job.id,companyId:actor.companyId},{createdBy:actor.id});
      await em.insert(AuditLog,{companyId:actor.companyId,actorId:actor.id,action:'staff.feishu.test',resourceType:'user',resourceId:String(id),detail:{jobId:job.id,notificationId:Number(saved.identifiers[0]?.id)}});
      return job.id;
    });
    return this.testStatus(actor,id,jobId);
  }
  async testStatus(actor:AuthUser,id:number,jobId:number) {
    this.permission(actor,true);
    const job=await this.ds.manager.findOne(OutboxJob,{where:{id:jobId,companyId:actor.companyId,resourceType:RESOURCE,resourceId:id,createdBy:actor.id}});
    if(!job)throw new NotFoundException('测试通知不存在');
    const sw=await this.ds.manager.findOne(OutboxSwitch,{where:{companyId:actor.companyId,channel:'feishu'}});
    const status=job.status==='pending'&&!sw?.enabled?'paused':job.status;
    const messages:Record<string,string>={pending:'测试通知已加入队列，等待通知助手发送',sending:'通知助手正在发送',done:'飞书接口已确认发送成功，请本人在飞书查看',failed:'未确认发送成功，请检查飞书绑定、应用权限与通知通道；不要反复重发',cancelled:'测试通知已取消',paused:'公司飞书通知总开关已关闭，测试通知暂停发送'};
    return {jobId:job.id,userId:id,status,message:messages[status],createdAt:job.createdAt,doneAt:job.doneAt};
  }
}
