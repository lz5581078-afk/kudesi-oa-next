import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { CryptoService } from './common/crypto.service';
import { IntegrationSetting, ResourceChangeLog } from './entities';
import { FilesService } from './integrations/files.service';
import { IntegrationSettingsService } from './integrations/integration-settings.service';
import { OcrService } from './integrations/ocr.service';
import type { ObjectStorage } from './integrations/qiniu.client';
import { ResourcesService } from './resources/resources.service';
import { RevenueService } from './resources/revenue.service';

/** 内存里的假存储：记录上传和删除，不联网。 */
export class FakeStorage implements ObjectStorage {
  objects = new Map<string, { mime: string; size: number }>();
  removed: string[] = [];
  failUpload = false;
  async upload(key: string, data: Buffer, mime: string) {
    if (this.failUpload) throw new Error('七牛上传失败（401）bad token');
    this.objects.set(key, { mime, size: data.length });
  }
  downloadUrl(key: string) {
    return `https://fake.example.com/${key}?e=1&token=t`;
  }
  async remove(key: string) {
    this.removed.push(key);
    this.objects.delete(key);
  }
}

/** 数据库测试用：按真实依赖关系组装服务，只把七牛换成内存假存储。 */
export function buildServices(ds: DataSource) {
  const key = Buffer.from(crypto.randomBytes(32));
  const cryptoService = new CryptoService({ k1: key }, 'k1');
  const storage = new FakeStorage();
  const settings = new IntegrationSettingsService(ds.getRepository(IntegrationSetting), ds.getRepository(ResourceChangeLog), cryptoService);
  const files = new FilesService(ds, settings, () => storage);
  const ocr = new OcrService(settings);
  const resources = new ResourcesService(ds, cryptoService, files);
  const revenue = new RevenueService(ds);
  return { resources, revenue, files, settings, ocr, storage, crypto: cryptoService };
}
