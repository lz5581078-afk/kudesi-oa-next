import { scrypt, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcryptjs';

const LEGACY = /^legacy-scrypt-v1\$([0-9a-f]{32})\$([0-9a-f]{128})$/i;

/** 仅迁移CLI使用：存旧盐/哈希，无需知道或重置原密码。 */
export function encodeLegacyPassword(salt: string, hash: string): string {
  const value = `legacy-scrypt-v1$${salt}$${hash}`;
  if (!LEGACY.test(value)) throw new Error('旧密码凭据格式无效');
  return value;
}
export function isLegacyPassword(value: string): boolean { return LEGACY.test(value); }
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const m = LEGACY.exec(encoded);
  if (!m) return encoded.startsWith('$2') ? bcrypt.compare(password, encoded) : false;
  // 旧系统使用盐的hex字符串作为scrypt盐；不得先解码成字节。
  const actual = await new Promise<Buffer>((resolve, reject) => scrypt(password, m[1], 64, (e, key) => e ? reject(e) : resolve(key)));
  return timingSafeEqual(actual, Buffer.from(m[2], 'hex'));
}
