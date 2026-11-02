import { Injectable } from '@nestjs/common';
import { ExternalConfigService, FeishuConfig } from '../integrations/external-config.service';

/** A binding must belong to the employee and the company's current Feishu application and tenant. */
@Injectable()
export class FeishuBindingPolicy {
  constructor(private readonly settings: ExternalConfigService) {}

  async isBound(companyId: number, userId: number): Promise<boolean> {
    let cfg: FeishuConfig | null;
    try { cfg = await this.settings.read<FeishuConfig>(companyId, 'feishu'); }
    catch { return false; }
    if (!cfg?.appId || !cfg.tenantKey) return false;
    const [binding] = await this.settings.ds.query('SELECT id FROM feishu_identities WHERE company_id=? AND user_id=? AND app_id=? AND tenant_key=? LIMIT 1', [companyId, userId, cfg.appId, cfg.tenantKey]);
    return Boolean(binding);
  }
}
