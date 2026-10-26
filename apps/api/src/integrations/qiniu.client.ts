import * as crypto from 'crypto';

export type QiniuZone = 'z0' | 'z1' | 'z2' | 'na0' | 'as0';

export interface QiniuConfig {
  accessKey: string;
  secretKey: string;
  bucket: string;
  zone: QiniuZone;
  /** 外链域名，带协议，如 https://cdn.example.com */
  domain: string;
  /** 空间是否私有：私有时下载链接要带签名 */
  isPrivate: boolean;
}

export const QINIU_ZONES: Record<QiniuZone, { label: string; uploadHost: string }> = {
  z0: { label: '华东-浙江', uploadHost: 'https://upload.qiniup.com' },
  z1: { label: '华北-河北', uploadHost: 'https://upload-z1.qiniup.com' },
  z2: { label: '华南-广东', uploadHost: 'https://upload-z2.qiniup.com' },
  na0: { label: '北美-洛杉矶', uploadHost: 'https://upload-na0.qiniup.com' },
  as0: { label: '亚太-新加坡', uploadHost: 'https://upload-as0.qiniup.com' },
};

/** 文件存储抽象：业务代码只依赖它，测试里用内存实现替换。 */
export interface ObjectStorage {
  upload(key: string, data: Buffer, mime: string, filename: string): Promise<void>;
  downloadUrl(key: string, ttlSeconds?: number): string;
  remove(key: string): Promise<void>;
}

const urlSafe = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_');

/**
 * 七牛云客户端：表单上传 + 私有空间下载签名 + 删除。
 * 参数都由管理员在“接口设置”里填写；构造时可注入 fetch，便于测试。
 */
export class QiniuClient implements ObjectStorage {
  constructor(
    private readonly cfg: QiniuConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  sign(data: string): string {
    return urlSafe(crypto.createHmac('sha1', this.cfg.secretKey).update(data).digest('base64'));
  }

  uploadToken(key: string, ttlSeconds = 600, maxBytes?: number): string {
    const policy: Record<string, unknown> = {
      // 只允许上传到这个具体的 key，不能覆盖别的文件
      scope: `${this.cfg.bucket}:${key}`,
      deadline: Math.floor(this.now() / 1000) + ttlSeconds,
    };
    if (maxBytes) policy.fsizeLimit = maxBytes;
    const encoded = urlSafe(Buffer.from(JSON.stringify(policy)).toString('base64'));
    return `${this.cfg.accessKey}:${this.sign(encoded)}:${encoded}`;
  }

  async upload(key: string, data: Buffer, mime: string, filename: string): Promise<void> {
    const form = new FormData();
    form.append('token', this.uploadToken(key, 600, data.length + 1024));
    form.append('key', key);
    form.append('file', new Blob([new Uint8Array(data)], { type: mime }), filename);
    const res = await this.fetchFn(QINIU_ZONES[this.cfg.zone].uploadHost, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      let detail = '';
      try {
        detail = ((await res.json()) as { error?: string }).error ?? '';
      } catch {
        /* 响应不是 JSON */
      }
      throw new Error(`七牛上传失败（${res.status}）${detail}`);
    }
  }

  downloadUrl(key: string, ttlSeconds = 300): string {
    const base = `${this.cfg.domain.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
    if (!this.cfg.isPrivate) return base;
    const withExpiry = `${base}?e=${Math.floor(this.now() / 1000) + ttlSeconds}`;
    return `${withExpiry}&token=${this.cfg.accessKey}:${this.sign(withExpiry)}`;
  }

  async remove(key: string): Promise<void> {
    const entry = urlSafe(Buffer.from(`${this.cfg.bucket}:${key}`).toString('base64'));
    const path = `/delete/${entry}`;
    const res = await this.fetchFn(`https://rs.qiniuapi.com${path}`, {
      method: 'POST',
      headers: { Authorization: `QBox ${this.cfg.accessKey}:${this.sign(`${path}\n`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(20_000),
    });
    // 612 = 文件本来就不存在，视为成功
    if (!res.ok && res.status !== 612) throw new Error(`七牛删除失败（${res.status}）`);
  }
}
