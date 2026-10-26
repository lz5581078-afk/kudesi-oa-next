import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * 业务敏感信息加密（证件号、银行卡号、店铺密钥等）。AES-256-GCM。
 * 密文格式：v1:<keyId>:<iv base64>:<tag base64>:<密文 base64>
 * 带 keyId 是为了支持密钥轮换：新数据用 active 密钥加密，旧数据仍能按自己的 keyId 解开。
 * 密钥只来自环境配置，没有任何内置默认值。
 */
@Injectable()
export class CryptoService {
  constructor(
    private readonly keys: Record<string, Buffer>,
    private readonly activeKeyId: string,
  ) {
    if (!keys[activeKeyId]) throw new Error(`加密密钥 ${activeKeyId} 不存在`);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys[this.activeKeyId], iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', this.activeKeyId, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
  }

  decrypt(token: string): string {
    const parts = token.split(':');
    if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('无法识别的密文格式');
    const [, keyId, ivB64, tagB64, dataB64] = parts;
    const key = this.keys[keyId];
    if (!key) throw new Error(`找不到解密密钥 ${keyId}`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }

  /** 列表里展示用的脱敏：只留前后各几位，永远不把明文发给前端。 */
  static mask(plain: string, keepStart = 3, keepEnd = 4): string {
    if (plain.length <= keepStart + keepEnd) return '*'.repeat(plain.length);
    return `${plain.slice(0, keepStart)}${'*'.repeat(plain.length - keepStart - keepEnd)}${plain.slice(-keepEnd)}`;
  }
}
