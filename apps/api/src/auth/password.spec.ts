import { scryptSync } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { encodeLegacyPassword, isLegacyPassword, verifyPassword } from './password';

describe('旧密码兼容', () => {
  const salt = '0123456789abcdef0123456789abcdef';
  const password = '用于测试的原密码-123';
  const encoded = encodeLegacyPassword(salt, scryptSync(password, salt, 64).toString('hex'));
  it('支持旧系统原密码并拒绝错误密码', async () => {
    expect(isLegacyPassword(encoded)).toBe(true);
    expect(await verifyPassword(password, encoded)).toBe(true);
    expect(await verifyPassword('wrong', encoded)).toBe(false);
  });
  it('盐必须以旧字符串方式参与计算', async () => {
    const wrong = encodeLegacyPassword(salt, scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex'));
    expect(await verifyPassword(password, wrong)).toBe(false);
  });
  it('拒绝畸形凭据与非密码标记', async () => {
    expect(() => encodeLegacyPassword('', 'abc')).toThrow();
    expect(await verifyPassword('', '!no-login')).toBe(false);
    expect(await verifyPassword(password, encoded.slice(0, -1))).toBe(false);
  });
  it('继续支持bcrypt', async () => {
    expect(await verifyPassword(password, await bcrypt.hash(password, 4))).toBe(true);
  });
});
