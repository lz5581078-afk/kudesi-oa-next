import { liveNoStartNotification } from './live-no-start-notification';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { liveAddDays, liveFromText, liveToday } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ExternalConfigService, FeishuConfig } from '../integrations/external-config.service';
import { liveClock, liveFail, lockCompany, Row, wallNow } from './live-core';
import { liveNotify, liveRecipientAllowed } from './live-notification-events';

export interface LiveNotificationSettings {
  enabled: boolean; digestEnabled: boolean; digestHour: number; businessRecipients: number[]; systemRecipients: number[];
}
const ids = (value: unknown): number[] => { try { const a = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(a) ? [...new Set(a.map(Number).filter(n => Number.isSafeInteger(n) && n > 0))] : []; } catch { return []; } };
export const liveMinutesLate = (now: Date, text: string) => Math.floor((+now - +(liveFromText(text) ?? now)) / 60000);

@Injectable()
export class LiveNotificationService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly external: ExternalConfigService) {}

  private async read(em: EntityManager, companyId: number): Promise<LiveNotificationSettings & { activatedAt?: string }> {
    const [r] = await em.query("SELECT *, DATE_FORMAT(activated_at,'%Y-%m-%d %H:%i:%s') activated_text FROM live_notification_settings WHERE company_id=?", [companyId]);
    if (r) return { enabled: !!r.enabled, digestEnabled: !!r.digest_enabled, digestHour: Number(r.digest_hour), businessRecipients: ids(r.business_recipients), systemRecipients: ids(r.system_recipients), activatedAt: r.activated_text };
    const cfg = await this.external.read<FeishuConfig>(companyId, 'feishu');
    const recipients = (key: string) => ids(cfg?.channels?.find(c => c.key === key && c.enabled)?.recipientUserIds);
    return { enabled: true, digestEnabled: false, digestHour: 9, businessRecipients: recipients('business'), systemRecipients: recipients('system') };
  }

  async settings(user: AuthUser) {
    const settings = await this.read(this.ds.manager,user.companyId);
    const people: {id:number;name:string;business:boolean;system:boolean}[] = [];
    for (const p of await this.ds.query("SELECT id,name FROM users WHERE company_id=? AND status='active' ORDER BY id",[user.companyId])) {
      const business = await liveRecipientAllowed(this.ds.manager,user.companyId,Number(p.id),'features.live.view');
      const system = await liveRecipientAllowed(this.ds.manager,user.companyId,Number(p.id),'system.integrations.view');
      if (business || system) people.push({id:Number(p.id),name:p.name,business,system});
    }
    return { ...settings, businessRecipients: settings.businessRecipients.filter(id=>people.some(p=>p.id===id&&p.business)), systemRecipients: settings.systemRecipients.filter(id=>people.some(p=>p.id===id&&p.system)), configured: !!settings.activatedAt, people };
  }

  async save(user: AuthUser, input: LiveNotificationSettings) {
    if (input.enabled && input.digestEnabled && !input.businessRecipients.length) liveFail('请选择经营日报接收人',400);
    await this.ds.transaction(async em => {
      await lockCompany(em,user.companyId);
      for (const [list,permission] of [[input.businessRecipients,'features.live.view'],[input.systemRecipients,'system.integrations.view']] as const) {
        for (const id of list) if (!await liveRecipientAllowed(em,user.companyId,id,permission)) liveFail('接收人不存在、已停用或没有对应查看权限',400);
      }
      await em.query(`INSERT INTO live_notification_settings(company_id,enabled,digest_enabled,digest_hour,business_recipients,system_recipients,activated_at,updated_by)
        VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE activated_at=IF(enabled=0 AND VALUES(enabled)=1,VALUES(activated_at),activated_at),
        enabled=VALUES(enabled),digest_enabled=VALUES(digest_enabled),digest_hour=VALUES(digest_hour),business_recipients=VALUES(business_recipients),system_recipients=VALUES(system_recipients),updated_by=VALUES(updated_by)`,
        [user.companyId,input.enabled,input.digestEnabled,input.digestHour,JSON.stringify(ids(input.businessRecipients)),JSON.stringify(ids(input.systemRecipients)),wallNow(liveClock.now()),user.id]);
      await em.query('INSERT INTO audit_logs(company_id,actor_id,action,resource_type,resource_id,detail) VALUES(?,?,?,?,?,?)',[user.companyId,user.id,'live.notification.settings','live-notification-settings',String(user.companyId),JSON.stringify(input)]);
    });
    return this.settings(user);
  }

  /** Durable counters count separate attempts, never cache hits; successful recovery resets the streak. */
  async health(companyId: number, key: string, ok: boolean) {
    await this.ds.transaction(async em => {
      await lockCompany(em,companyId);
      const now=wallNow(liveClock.now());
      await em.query(`INSERT INTO live_notification_health(company_id,health_key,failures,first_failed_at,updated_at) VALUES(?,?,?,?,?)
        ON DUPLICATE KEY UPDATE first_failed_at=IF(VALUES(failures)=0,NULL,IF(failures=0,VALUES(first_failed_at),first_failed_at)),failures=IF(VALUES(failures)=0,0,failures+1),updated_at=VALUES(updated_at)`,[companyId,key,ok?0:1,ok?null:now,now]);
      if (ok) return;
      const [r] = await em.query("SELECT *,DATE_FORMAT(first_failed_at,'%Y-%m-%d %H:%i:%s') first_text FROM live_notification_health WHERE company_id=? AND health_key=?",[companyId,key]);
      if (Number(r.failures)<3 || liveMinutesLate(liveClock.now(),r.first_text)<5) return;
      const cfg=await this.read(em,companyId);
      if (!cfg.activatedAt) return;
      await liveNotify(em,companyId,cfg.systemRecipients,{key:`health:${key}:${liveToday(liveClock.now())}`,channel:'system',title:'直播订单或售后查询连续异常',body:'直播经营数据核对连续失败，可能影响下播填报或结算。请检查聚水潭授权及接口连接；恢复后再核对，不能把查询失败当作零营业额。',link:'/system/integrations'});
    });
  }

  async scan() {
    const companies: Row[]=await this.ds.query("SELECT s.company_id FROM live_notification_settings s JOIN companies c ON c.id=s.company_id AND c.status='active' WHERE s.enabled=1");
    for (const c of companies) await this.ds.transaction(async em => {
      const companyId=Number(c.company_id);
      await lockCompany(em,companyId);
      const cfg=await this.read(em,companyId);
      if (!cfg.enabled || !cfg.activatedAt) return;
      const now=liveClock.now(), text=wallNow(now), day=liveToday(now);
      const schedules: Row[]=await em.query(`SELECT s.*,DATE_FORMAT(s.start_at,'%Y-%m-%d %H:%i:%s') start_text,r.owner_user_id FROM live_schedules s
        LEFT JOIN live_room_settings r ON r.company_id=s.company_id AND r.room_id=s.room_id
        WHERE s.company_id=? AND s.status='scheduled' AND s.start_at>=? AND s.start_at<=? AND s.start_at>=DATE_SUB(?,INTERVAL 2 DAY)`,[companyId,cfg.activatedAt,text,text]);
      for (const s of schedules) {
        const late=liveMinutesLate(now,s.start_text);
        if (late<5) continue;
        if (late>=10) await liveNoStartNotification(em,companyId,Number(s.id),now);
        const level=late>=30?'owner':'crew';
        await liveNotify(em,companyId,level==='owner'?[Number(s.owner_user_id)]:[s.anchor_user_id,s.control_user_id,s.operator_user_id].map(Number),
          {key:`late:${s.id}:${s.notification_version}:${level}`,channel:'supervision',title:'排场已到时间，尚未登记上播',body:`${s.room_name}原定 ${s.start_text} 开播，请确认实际情况并及时登记。`,resourceId:Number(s.id)});
      }
      const sessions: Row[]=await em.query(`SELECT s.*,DATE_FORMAT(s.end_at,'%Y-%m-%d %H:%i:%s') end_text,
        DATE_FORMAT(p.end_at,'%Y-%m-%d %H:%i:%s') planned_end,r.owner_user_id FROM live_sessions s
        LEFT JOIN live_schedules p ON p.company_id=s.company_id AND p.id=s.schedule_id
        LEFT JOIN live_room_settings r ON r.company_id=s.company_id AND r.room_id=s.room_id
        WHERE s.company_id=? AND s.status IN ('live','pending_report','returned') AND s.start_at>=? AND s.start_at>=DATE_SUB(?,INTERVAL 2 DAY)`,[companyId,cfg.activatedAt,text]);
      for (const s of sessions) {
        if (s.status==='live') {
          if (!s.planned_end || liveMinutesLate(now,s.planned_end)<10) continue;
          const owner=liveMinutesLate(now,s.planned_end)>=30;
          await liveNotify(em,companyId,owner?[Number(s.owner_user_id)]:[s.anchor_user_id,s.control_user_id,s.operator_user_id].map(Number),
            {key:`overrun:${s.id}:${owner?'owner':'crew'}`,channel:'supervision',title:'已超过预计下播时间',body:`${s.room_name}超过预计下播时间，请确认是否仍在直播，已下播请及时填报。`,resourceId:Number(s.id)});
          continue;
        }
        if (!s.end_text || liveMinutesLate(now,s.end_text)<30 || s.status==='returned') continue; // Returned runs use the flow engine's deadlines.
        const reports: Row[]=await em.query('SELECT role,reporter_user_id,manual_actor_id FROM live_session_reports WHERE company_id=? AND session_id=?',[companyId,s.id]);
        const missing=[['anchor',s.anchor_user_id],['control',s.control_user_id]].filter(([role,id])=>id&&!reports.some(r=>r.role===role&&(r.manual_actor_id||Number(r.reporter_user_id)===Number(id)))).map(([,id])=>Number(id));
        const owner=liveMinutesLate(now,s.end_text)>=120;
        await liveNotify(em,companyId,owner?[Number(s.owner_user_id)]:missing.length?missing:[Number(s.anchor_user_id),Number(s.control_user_id)],
          {key:`report:${s.id}:${missing.length?'missing':'submit'}:${owner?'owner':'crew'}`,channel:'supervision',title:missing.length?'下播报告尚未填齐':'下播报告已齐，请提交审核',body:`${s.room_name}场次仍待处理，请在「我的直播」完成${missing.length?'本人下播报告':'提交审核'}。`,resourceId:Number(s.id)});
      }
      await this.expiry(em,companyId,cfg,day);
      if (cfg.digestEnabled && Number(text.slice(11,13))>=cfg.digestHour) await this.digest(em,companyId,cfg,liveAddDays(day,-1));
    });
  }

  private async expiry(em:EntityManager,companyId:number,cfg:LiveNotificationSettings,day:string) {
    const stores:Row[]=await em.query(`SELECT id,title,JSON_UNQUOTE(JSON_EXTRACT(data,'$.jushuitanExpireAt')) expires
      FROM resource_records WHERE company_id=? AND type='stores' AND status='normal'
      AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.jushuitanShopId')) IS NOT NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.jushuitanExpiryStatus'))='dated'`,[companyId]);
    for (const s of stores) {
      const expires=String(s.expires||'');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)||expires>liveAddDays(day,7)) continue;
      const stage=expires<day?'expired':'soon';
      await liveNotify(em,companyId,cfg.systemRecipients,{key:`expiry:${s.id}:${expires}:${stage}`,channel:'system',title:stage==='expired'?'店铺聚水潭授权已到期':'店铺聚水潭授权即将到期',body:`${s.title}的聚水潭授权日期为 ${expires}，请及时续期并刷新店铺授权信息。`,link:'/resource/stores',resourceId:Number(s.id)});
    }
  }

  private async digest(em:EntityManager,companyId:number,cfg:LiveNotificationSettings,day:string) {
    // Aggregate sessions once. Commission records repeat per role/platform and must not multiply sales.
    const [r]=await em.query(`SELECT COUNT(*) total,SUM(status='approved') approved,SUM(status='live') broadcasting,
      SUM(status IN ('pending_report','returned')) incomplete,SUM(status='submitted') reviewing,
      COALESCE(SUM(IF(status='approved',final_sales_cents,0)),0) sales FROM live_sessions WHERE company_id=? AND session_date=?`,[companyId,day]);
    const rows:Row[]=await em.query(`SELECT session_id,platform,MAX(ad_spend_cents) ad,MAX(final_sales_cents) sales, MAX(below_roi) below_roi FROM live_commission_records WHERE company_id=? AND session_date=? GROUP BY session_id,platform`,[companyId,day]);
    const ad=rows.reduce((n,v)=>n+Number(v.ad??0),0), sales=rows.reduce((n,v)=>n+Number(v.sales),0);
    const below = new Set(rows.filter(v=>Number(v.below_roi)).map(v=>Number(v.session_id))).size;
    const roi=rows.length&&rows.every(v=>v.ad!==null)&&ad>0?(sales/ad).toFixed(2):'暂不可计算';
    const [missed]=await em.query("SELECT COUNT(*) n FROM live_schedules WHERE company_id=? AND schedule_date=? AND status='scheduled'",[companyId,day]);
    await liveNotify(em,companyId,cfg.businessRecipients,{key:`digest:${day}`,channel:'business',title:`直播经营日报 ${day}`,body:`共 ${r.total} 场，已审核 ${Number(r.approved||0)} 场；已审核销售额 ${(Number(r.sales)/100).toFixed(2)} 元，已记录投流 ${(ad/100).toFixed(2)} 元，已审核ROI ${roi}，低于规则ROI阈值 ${below} 场。\n待补报/待提交 ${Number(r.incomplete||0)} 场，待审核 ${Number(r.reviewing||0)} 场，仍显示直播中 ${Number(r.broadcasting||0)} 场，未登记上播排场 ${missed.n} 场。\n销售额仅含当前已审核场次，非聚水潭实时净营业额；晚审核数据请在直播管理核对。`,link:'/features/live?tab=overview'});
  }
}
