import { Injectable } from '@nestjs/common';
import { ExternalConfigService, FeishuConfig } from '../integrations/external-config.service';
import { FeishuClient } from '../integrations/feishu.client';
import { FeishuNotice, FeishuSender } from './feishu-notice.service';
@Injectable()
export class ConnectedFeishuSender implements FeishuSender {
  readonly configured = true;
  constructor(private readonly config: ExternalConfigService, private readonly client: FeishuClient) {}
  async available(companyId: number) { const cfg = await this.config.read<FeishuConfig>(companyId, 'feishu'); return Boolean(cfg?.enabled && cfg.appId && cfg.appSecret && cfg.tenantKey); }
  async send(job: { companyId?: number; idempotencyKey: string; notice: FeishuNotice }) {
    if (!job.companyId) throw new Error('飞书发送缺少公司范围');
    const cfg = await this.config.read<FeishuConfig>(job.companyId, 'feishu');
    if (!cfg?.enabled || !cfg.tenantKey) throw new Error('飞书公司授权未启用');
    const [binding] = await this.config.ds.query("SELECT b.open_id,b.union_id FROM feishu_identities b JOIN users u ON u.id=b.user_id AND u.company_id=b.company_id WHERE b.company_id=? AND b.user_id=? AND b.app_id=? AND b.tenant_key=? AND u.status='active'", [job.companyId, job.notice.userId, cfg.appId, cfg.tenantKey]);
    if (!binding) throw new Error('接收员工尚未绑定本公司飞书身份');
    const key = job.notice.channel ?? 'flow';
    if (!['flow', 'business', 'notice', 'supervision', 'system', 'task', 'live'].includes(key)) throw new Error('飞书通知通道不合法');
    const channel = cfg.channels?.find(c => c.key === key);
    if (key !== 'flow' && !channel) throw new Error('飞书通道尚未配置');
    if (channel && !channel.enabled) throw new Error('飞书流程通道已关闭');
    const origin = new URL(cfg.origin);
    if (origin.protocol !== 'https:') throw new Error('飞书链接域名必须使用 HTTPS');
    const rawLink = job.notice.link;
    const link = rawLink ? new URL(rawLink, origin) : null;
    if (link && link.origin !== origin.origin) throw new Error('通知链接超出本站范围');
    const text = [job.notice.title, job.notice.body, link?.href].filter(Boolean).join('\n').slice(0, 6000);
    const app = channel && !channel.inheritsMainApp ? channel : cfg;
    const sameApp = app.appId === cfg.appId;
    const receiveId = sameApp ? binding.open_id : binding.union_id;
    if (!receiveId) throw new Error('该通道需要统一飞书身份，请重新绑定');
    await this.client.send(app, receiveId, sameApp ? 'open_id' : 'union_id', text, `${job.companyId}:${key}:${job.idempotencyKey}`);
  }
}
