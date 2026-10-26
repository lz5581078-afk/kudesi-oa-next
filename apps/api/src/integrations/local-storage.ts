import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ObjectStorage } from './qiniu.client';

/** 本机私有存储；只能经通过资料权限检查后生成的短时签名链接读取。 */
export class LocalStorage implements ObjectStorage {
  constructor(private readonly root: string, private readonly signingKey: string, private readonly now: () => number = Date.now) {
    if (!path.isAbsolute(root) || signingKey.length < 32) throw new Error('本地文件存储配置无效');
  }
  private location(key: string) {
    key = key.replace(/^local:/, '');
    if (!/^oa\/\d+\/[a-z0-9-]+\/\d{6}\/[0-9a-f-]+\.(png|jpg|gif|webp|pdf)$/.test(key)) throw new Error('文件路径无效');
    return path.join(this.root, key);
  }
  async upload(key: string, data: Buffer): Promise<void> {
    const file = this.location(key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, data, { mode: 0o600, flag: 'wx' });
  }
  private sign(key: string, expires: string) { return createHmac('sha256', this.signingKey).update(`${key}\n${expires}`).digest('hex'); }
  downloadUrl(key: string, ttl = 300): string {
    this.location(key);
    const expires = String(Math.floor(this.now() / 1000) + Math.min(Math.max(ttl, 1), 300));
    return `/api/files/local/${Buffer.from(key).toString('base64url')}?expires=${expires}&signature=${this.sign(key, expires)}`;
  }
  async readSigned(token: string, expires: string, signature: string): Promise<Buffer> {
    if (token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token) || !/^\d{10}$/.test(expires) || !/^[0-9a-f]{64}$/.test(signature)) throw new Error('文件链接无效');
    const seconds = Math.floor(this.now() / 1000);
    if (Number(expires) <= seconds || Number(expires) > seconds + 300) throw new Error('文件链接过期');
    const key = Buffer.from(token, 'base64url').toString('utf8');
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.sign(key, expires), 'hex'))) throw new Error('文件链接无效');
    return readFile(this.location(key));
  }
  async remove(key: string): Promise<void> { await unlink(this.location(key)).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
}
export function configuredLocalStorage(): LocalStorage | null {
  if (!process.env.FILES_LOCAL_ROOT) return null;
  return new LocalStorage(process.env.FILES_LOCAL_ROOT, process.env.JWT_SECRET ?? '');
}
