import { createLegacyLabHandler } from './lab-bridge';
import type { LegacySql } from './lab-bridge';
import type { CryptoService } from '../../common/crypto.service';

describe('本地旧模块样例默认关闭', () => {
  it('没有显式开关或处于production时，不读取旧源码或连接数据库', () => {
    const previous = process.env.SESSION_LEGACY_LAB, mode = process.env.NODE_ENV;
    const sql = { query: jest.fn(), execute: jest.fn(), withTransaction: jest.fn() };
    try {
      delete process.env.SESSION_LEGACY_LAB;
      expect(() => createLegacyLabHandler('not-a-real-path', sql as LegacySql, {} as CryptoService)).toThrow(/local lab/);
      process.env.SESSION_LEGACY_LAB = '1'; process.env.NODE_ENV = 'production';
      expect(() => createLegacyLabHandler('not-a-real-path', sql as LegacySql, {} as CryptoService)).toThrow(/local lab/);
      expect(sql.query).not.toHaveBeenCalled(); expect(sql.execute).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.SESSION_LEGACY_LAB; else process.env.SESSION_LEGACY_LAB = previous;
      if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode;
    }
  });
});
