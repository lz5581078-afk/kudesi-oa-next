import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CryptoService } from '../common/crypto.service';

export interface JstAccount { name: string; coid: string | number; accessToken: string; refreshToken?: string; tokenExpiresAt?: string; baseUrl?: string }
export interface FeishuConfig { appId: string; appSecret: string; tenantKey: string; origin: string; enabled: boolean; channels: Array<{ key: string; appId: string; appSecret: string; inheritsMainApp: boolean; enabled: boolean; recipientUserIds: number[] }> }
/** 仅供服务端内部使用，绝不把解密后的配置交给控制器。 */
@Injectable()
export class ExternalConfigService {
  constructor(@InjectDataSource() readonly ds: DataSource, private readonly crypto: CryptoService) {}
  async read<T>(companyId: number, key: 'jushuitan' | 'feishu'): Promise<T | null> {
    const [r] = await this.ds.query('SELECT config_enc FROM integration_settings WHERE company_id=? AND setting_key=?', [companyId, key]);
    if (!r) return null;
    try { return JSON.parse(this.crypto.decrypt(r.config_enc)) as T; }
    catch { throw new Error('接口配置无法解密，请管理员检查加密密钥'); }
  }
  async jst(companyId: number) {
    const cfg = await this.read<{ accounts: JstAccount[] }>(companyId, 'jushuitan');
    const accounts = (cfg?.accounts ?? []).filter(a => a.accessToken && a.coid);
    if (accounts.length !== 1) throw new Error('需要唯一的聚水潭公司授权账户');
    const [a] = await this.ds.query("SELECT app_key_enc,app_secret_enc,base_url FROM platform_integration_apps WHERE integration_key='jushuitan' AND environment='production' AND status='active'");
    if (!a) throw new Error('聚水潭正式应用尚未配置');
    const account = accounts[0];
    if (account.tokenExpiresAt && new Date(account.tokenExpiresAt.replace(' ', 'T') + (/Z|[+]\d\d:\d\d$/.test(account.tokenExpiresAt) ? '' : '+08:00')).getTime() <= Date.now()) throw new Error('聚水潭授权已过期，请续期后重试');
    return { ...account, appKey: this.crypto.decrypt(a.app_key_enc), appSecret: this.crypto.decrypt(a.app_secret_enc), baseUrl: account.baseUrl || a.base_url || 'https://openapi.jushuitan.com', targetKey: `jst:${companyId}:${account.coid}` };
  }
}
