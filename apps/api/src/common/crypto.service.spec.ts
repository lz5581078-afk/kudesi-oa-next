import { randomBytes } from 'crypto';
import { loadEnv, parseEncryptionKeys } from '../config/env';
import { CryptoService } from './crypto.service';

const key = () => randomBytes(32);

describe('CryptoService', () => {
  it('加密后能解回原文，且每次密文不同', () => {
    const service = new CryptoService({ k1: key() }, 'k1');
    const a = service.encrypt('110101199001011234');
    const b = service.encrypt('110101199001011234');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:k1:')).toBe(true);
    expect(service.decrypt(a)).toBe('110101199001011234');
  });

  it('密钥轮换：新数据用新密钥，旧密文仍能解开', () => {
    const k1 = key();
    const k2 = key();
    const oldService = new CryptoService({ k1 }, 'k1');
    const oldToken = oldService.encrypt('旧数据');
    const rotated = new CryptoService({ k1, k2 }, 'k2');
    expect(rotated.encrypt('新数据').startsWith('v1:k2:')).toBe(true);
    expect(rotated.decrypt(oldToken)).toBe('旧数据');
  });

  it('密文被篡改会解密失败', () => {
    const service = new CryptoService({ k1: key() }, 'k1');
    const parts = service.encrypt('secret').split(':');
    parts[4] = Buffer.from('tampered').toString('base64');
    expect(() => service.decrypt(parts.join(':'))).toThrow();
  });

  it('找不到密钥时报错，而不是回退到默认密钥', () => {
    const token = new CryptoService({ k1: key() }, 'k1').encrypt('x');
    expect(() => new CryptoService({ k2: key() }, 'k2').decrypt(token)).toThrow('找不到解密密钥');
  });

  it('脱敏只保留首尾', () => {
    expect(CryptoService.mask('6222021234567890123')).toBe('622************0123');
    expect(CryptoService.mask('1234')).toBe('****');
  });
});

describe('环境配置', () => {
  const base = {
    DB_NAME: 'x',
    DB_USER: 'u',
    DB_PASSWORD: 'p',
    JWT_SECRET: 'a'.repeat(40),
    DATA_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    DATA_ENCRYPTION_ACTIVE_KEY: 'k1',
  };

  it('配置齐全时可以加载', () => {
    expect(loadEnv(base as NodeJS.ProcessEnv).encryptionActiveKeyId).toBe('k1');
  });

  it('缺少密钥或密钥太弱时启动失败，没有默认值', () => {
    expect(() => loadEnv({ ...base, JWT_SECRET: '' } as NodeJS.ProcessEnv)).toThrow('JWT_SECRET');
    expect(() => loadEnv({ ...base, JWT_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow('32');
    expect(() => loadEnv({ ...base, DATA_ENCRYPTION_KEYS: '' } as NodeJS.ProcessEnv)).toThrow('DATA_ENCRYPTION_KEYS');
    expect(() => loadEnv({ ...base, DATA_ENCRYPTION_ACTIVE_KEY: 'k9' } as NodeJS.ProcessEnv)).toThrow('k9');
  });

  it('加密密钥必须是 32 字节', () => {
    expect(() => parseEncryptionKeys(`k1:${Buffer.from('short').toString('base64')}`)).toThrow('32 字节');
  });
});
