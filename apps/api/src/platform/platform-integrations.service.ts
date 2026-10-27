import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PLATFORM_INTEGRATIONS, PLATFORM_INTEGRATION_ENVIRONMENTS, type PlatformIntegrationAppDto } from '@kudesi/shared';
import { PlatformAdminUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { checkHttpUrl } from '../integrations/integration-settings.service';

interface Row { id: number; integration_key: string; environment: string; app_key_enc: string; base_url: string | null; status: 'active' | 'disabled'; remark: string | null; updated_at: Date }

/** 平台级接口应用（聚水潭等）：App Key / Secret 加密保存；列表只给脱敏的 Key，Secret 任何接口都不返回；留空表示不修改。 */
@Injectable()
export class PlatformIntegrationService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly crypto: CryptoService) {}

  private toDto(r: Row): PlatformIntegrationAppDto {
    let masked = '（无法解密，请重新保存）';
    try { masked = CryptoService.mask(this.crypto.decrypt(r.app_key_enc)); } catch { /* 密钥轮换后旧数据读不出来：提示重新保存 */ }
    return { id: r.id, integrationKey: r.integration_key, environment: r.environment, appKeyMasked: masked, secretConfigured: true, baseUrl: r.base_url, status: r.status, remark: r.remark, updatedAt: r.updated_at.toISOString() };
  }

  async list(): Promise<PlatformIntegrationAppDto[]> {
    const rows: Row[] = await this.ds.query('SELECT id, integration_key, environment, app_key_enc, base_url, status, remark, updated_at FROM platform_integration_apps ORDER BY integration_key, environment');
    return rows.map((r) => this.toDto(r));
  }

  /** 新增或修改某个（接口、环境）的应用配置；新增时 Key 和 Secret 都必填，修改时留空表示不改。 */
  async save(admin: PlatformAdminUser, p: { integrationKey: string; environment: string; appKey?: string; appSecret?: string; baseUrl?: string; status?: 'active' | 'disabled'; remark?: string }) {
    if (!PLATFORM_INTEGRATIONS.some((i) => i.key === p.integrationKey)) throw new BadRequestException('接口类型不存在');
    if (!PLATFORM_INTEGRATION_ENVIRONMENTS.some((e) => e.key === p.environment)) throw new BadRequestException('环境不合法');
    const appKey = p.appKey?.trim(); const appSecret = p.appSecret?.trim();
    const baseUrl = p.baseUrl?.trim() ? checkHttpUrl(p.baseUrl, '接口地址') : null;
    const remark = p.remark?.trim().slice(0, 200) || null;
    const [old] = await this.ds.query('SELECT id FROM platform_integration_apps WHERE integration_key = ? AND environment = ?', [p.integrationKey, p.environment]);
    if (!old) {
      if (!appKey || !appSecret) throw new BadRequestException('新增时 App Key 和 App Secret 都要填');
      await this.ds.query('INSERT INTO platform_integration_apps (integration_key, environment, app_key_enc, app_secret_enc, base_url, status, remark, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [p.integrationKey, p.environment, this.crypto.encrypt(appKey), this.crypto.encrypt(appSecret), baseUrl, p.status ?? 'active', remark, admin.id]);
    } else {
      await this.ds.query('UPDATE platform_integration_apps SET app_key_enc = COALESCE(?, app_key_enc), app_secret_enc = COALESCE(?, app_secret_enc), base_url = ?, status = ?, remark = ?, updated_by = ? WHERE id = ?',
        [appKey ? this.crypto.encrypt(appKey) : null, appSecret ? this.crypto.encrypt(appSecret) : null, baseUrl, p.status ?? 'active', remark, admin.id, old.id]);
    }
    return this.list();
  }

  async remove(id: number) {
    const r = await this.ds.query('DELETE FROM platform_integration_apps WHERE id = ?', [id]);
    if (!r.affectedRows) throw new NotFoundException('配置不存在');
    return { ok: true };
  }

  /** 给将来的聚水潭授权/同步代码用：取出明文，只在服务端内部使用，不经过任何接口。 */
  async credentials(integrationKey: string, environment = 'production') {
    const [r] = await this.ds.query("SELECT app_key_enc, app_secret_enc, base_url FROM platform_integration_apps WHERE integration_key = ? AND environment = ? AND status = 'active'", [integrationKey, environment]);
    if (!r) return null;
    return { appKey: this.crypto.decrypt(r.app_key_enc), appSecret: this.crypto.decrypt(r.app_secret_enc), baseUrl: r.base_url as string | null };
  }
}
