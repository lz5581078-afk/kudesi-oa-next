import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { IntegrationSetting, ResourceChangeLog } from '../entities';
import { QINIU_ZONES, QiniuConfig, QiniuZone } from './qiniu.client';
import { VisionConfig } from './vision.client';

export type SettingKey = 'qiniu' | 'vision';

export interface QiniuInput {
  accessKey: string;
  /** 留空表示不修改 */
  secretKey?: string;
  bucket: string;
  zone: string;
  domain: string;
  isPrivate: boolean;
}

export interface VisionInput {
  baseUrl: string;
  /** 留空表示不修改 */
  apiKey?: string;
  model: string;
  enabled: boolean;
}

export function checkHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BadRequestException(`${label}不是有效的网址`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BadRequestException(`${label}必须以 http:// 或 https:// 开头`);
  return url.toString().replace(/\/+$/, '');
}

/** 第三方接口参数：按公司保存，整份加密；密钥类字段任何接口都不返回。 */
@Injectable()
export class IntegrationSettingsService {
  constructor(
    @InjectRepository(IntegrationSetting) private readonly repo: Repository<IntegrationSetting>,
    @InjectRepository(ResourceChangeLog) private readonly logs: Repository<ResourceChangeLog>,
    private readonly crypto: CryptoService,
  ) {}

  private async read<T>(companyId: number, key: SettingKey): Promise<T | null> {
    const row = await this.repo.findOne({ where: { companyId, settingKey: key } });
    if (!row) return null;
    try {
      return JSON.parse(this.crypto.decrypt(row.configEnc)) as T;
    } catch {
      return null;
    }
  }

  private async write(user: AuthUser, key: SettingKey, config: unknown, note: string) {
    const enc = this.crypto.encrypt(JSON.stringify(config));
    const existing = await this.repo.findOne({ where: { companyId: user.companyId, settingKey: key } });
    if (existing) await this.repo.update({ id: existing.id }, { configEnc: enc, updatedBy: user.id });
    else await this.repo.insert({ companyId: user.companyId, settingKey: key, configEnc: enc, updatedBy: user.id });
    // 复用资料变更日志表记录“谁改了接口设置”，不记录任何密钥内容
    await this.logs.insert({ companyId: user.companyId, resourceType: `setting:${key}`, resourceId: 0, action: 'update', actorId: user.id, note });
  }

  getQiniu(companyId: number) {
    return this.read<QiniuConfig>(companyId, 'qiniu');
  }

  getVision(companyId: number) {
    return this.read<VisionConfig>(companyId, 'vision');
  }

  /** 给设置页看的内容：参数原样返回，密钥只告诉“是否已设置”。 */
  async overview(companyId: number) {
    const q = await this.getQiniu(companyId);
    const v = await this.getVision(companyId);
    return {
      zones: Object.entries(QINIU_ZONES).map(([value, z]) => ({ value, label: z.label })),
      qiniu: {
        configured: Boolean(q),
        accessKey: q?.accessKey ?? '',
        secretKeyConfigured: Boolean(q?.secretKey),
        bucket: q?.bucket ?? '',
        zone: q?.zone ?? 'z0',
        domain: q?.domain ?? '',
        isPrivate: q?.isPrivate ?? true,
      },
      vision: {
        configured: Boolean(v),
        baseUrl: v?.baseUrl ?? '',
        apiKeyConfigured: Boolean(v?.apiKey),
        model: v?.model ?? '',
        enabled: v?.enabled ?? false,
      },
    };
  }

  async saveQiniu(user: AuthUser, input: QiniuInput) {
    const old = await this.getQiniu(user.companyId);
    const secretKey = input.secretKey?.trim() || old?.secretKey;
    if (!secretKey) throw new BadRequestException('请填写 SecretKey');
    if (!(input.zone in QINIU_ZONES)) throw new BadRequestException('存储区域不合法');
    if (!input.accessKey.trim() || !input.bucket.trim()) throw new BadRequestException('AccessKey 和空间名不能为空');
    const config: QiniuConfig = {
      accessKey: input.accessKey.trim(),
      secretKey,
      bucket: input.bucket.trim(),
      zone: input.zone as QiniuZone,
      domain: checkHttpUrl(input.domain, '外链域名'),
      isPrivate: Boolean(input.isPrivate),
    };
    await this.write(user, 'qiniu', config, '修改了七牛存储设置');
    return this.overview(user.companyId);
  }

  async saveVision(user: AuthUser, input: VisionInput) {
    const old = await this.getVision(user.companyId);
    const apiKey = input.apiKey?.trim() || old?.apiKey;
    if (!apiKey) throw new BadRequestException('请填写 API Key');
    if (!input.model.trim()) throw new BadRequestException('模型名不能为空');
    const config: VisionConfig = {
      baseUrl: checkHttpUrl(input.baseUrl, '接口地址'),
      apiKey,
      model: input.model.trim(),
      enabled: Boolean(input.enabled),
    };
    await this.write(user, 'vision', config, '修改了识别大模型设置');
    return this.overview(user.companyId);
  }
}
