import { Controller, Get } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { ExternalConfigService, FeishuConfig } from './external-config.service';
import { JushuitanClient } from './jushuitan.client';
import { FeishuClient } from './feishu.client';
@Controller('settings/integrations/connections')
export class ConnectionStatusController {
  constructor(private readonly config: ExternalConfigService, private readonly feishu: FeishuClient) {}
  @RequirePermission('system.integrations.view') @Get('jushuitan')
  async jst(@CurrentUser() user: AuthUser) {
    try {
      const cfg = await this.config.jst(user.companyId), c = new JushuitanClient(cfg);
      const all = await c.pages('/open/shops/query', {}, 'datas');
      const shops = all.filter(s => String(s.co_id) === String(cfg.coid));
      if (!shops.length) throw new Error('聚水潭令牌所属企业与配置不一致，或授权范围内没有店铺');
      return { ok: true, message: '聚水潭授权和店铺查询正常', shops: shops.map(r => ({ id: String(r.shop_id), name: String(r.shop_name ?? r.nick ?? ''), platform: String(r.shop_site ?? '') })) };
    } catch (e) { return { ok: false, message: (e as Error).message, shops: [] }; }
  }
  @RequirePermission('system.integrations.view') @Get('feishu')
  async fs(@CurrentUser() user: AuthUser) {
    const cfg = await this.config.read<FeishuConfig>(user.companyId, 'feishu');
    if (!cfg) return { ok: false, message: '飞书未配置', channels: [] };
    const apps = [{ key: 'main', appId: cfg.appId, appSecret: cfg.appSecret }, ...cfg.channels.filter(c => !c.inheritsMainApp).map(c => ({ key: c.key, appId: c.appId, appSecret: c.appSecret }))];
    const results: Array<{ key: string; ok: boolean; message: string }> = [];
    for (const a of apps) {
      try { await this.feishu.tenantToken(a); results.push({ key: a.key, ok: true, message: '应用鉴权正常' }); }
      catch (e) { results.push({ key: a.key, ok: false, message: (e as Error).message }); }
    }
    return { ok: cfg.enabled && results.every(r => r.ok), message: cfg.enabled ? '飞书应用凭据检查完成；通知另受发送开关控制' : '飞书公司授权未启用', channels: results };
  }
}
