import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IntegrationSetting, ResourceChangeLog } from '../entities';
import { CryptoService } from '../common/crypto.service';
import { AuthUser } from '../common/auth.decorators';

export const MAX_SPEECH_CONCURRENT = 2000;
export interface SpeechConfig { apiKey: string; enabled: boolean; fileEnabled: boolean; realtimeEnabled: boolean; maxConcurrent: number; allEmployees: boolean }
export type SpeechInput = Omit<SpeechConfig, 'apiKey' | 'allEmployees'> & { apiKey?: string; allEmployees?: boolean };

/** Reuse the company's encrypted integration settings; no vendor secret is returned. */
@Injectable()
export class SpeechSettingsService {
  constructor(@InjectRepository(IntegrationSetting) private readonly settings: Repository<IntegrationSetting>,
    @InjectRepository(ResourceChangeLog) private readonly logs: Repository<ResourceChangeLog>, private readonly crypto: CryptoService) {}

  async read(companyId: number): Promise<SpeechConfig | null> {
    const row = await this.settings.findOne({ where: { companyId, settingKey: 'collector-speech' } });
    if (!row) return null;
    try { return JSON.parse(this.crypto.decrypt(row.configEnc)); }
    catch { throw new ServiceUnavailableException('采集器配置暂时不可用，请联系管理员'); }
  }
  async overview(companyId: number) {
    const c = await this.read(companyId);
    return { configured: Boolean(c?.apiKey), enabled: c?.enabled ?? false, fileEnabled: c?.fileEnabled ?? true,
      realtimeEnabled: c?.realtimeEnabled ?? true, maxConcurrent: c?.maxConcurrent ?? 20, allEmployees: c?.allEmployees ?? true,
      fileApiVersion: 2, fileModel: '录音文件识别 2.0 标准版' };
  }
  async save(u: AuthUser, input: SpeechInput) {
    if (!Number.isInteger(input.maxConcurrent) || input.maxConcurrent < 1 || input.maxConcurrent > MAX_SPEECH_CONCURRENT)
      throw new BadRequestException(`公司语音并发上限须为 1–${MAX_SPEECH_CONCURRENT} 的整数`);
    const previous = await this.read(u.companyId);
    const apiKey = input.apiKey?.trim() || previous?.apiKey || '';
    if (input.enabled && !apiKey) throw new BadRequestException('请填写豆包语音 API Key');
    if (apiKey && !/^[\x21-\x7e]{1,300}$/.test(apiKey)) throw new BadRequestException('API Key 格式无效');
    const config: SpeechConfig = { apiKey, enabled: input.enabled, fileEnabled: input.fileEnabled,
      realtimeEnabled: input.realtimeEnabled, maxConcurrent: input.maxConcurrent, allEmployees: input.allEmployees ?? previous?.allEmployees ?? true };
    const configEnc = this.crypto.encrypt(JSON.stringify(config));
    await this.settings.upsert({ companyId: u.companyId, settingKey: 'collector-speech', configEnc, updatedBy: u.id }, ['companyId', 'settingKey']);
    await this.logs.insert({ companyId: u.companyId, resourceType: 'setting:collector-speech', resourceId: 0,
      action: 'update', actorId: u.id, note: '修改采集器语音设置（密钥不记入日志）' });
    return this.overview(u.companyId);
  }
}
