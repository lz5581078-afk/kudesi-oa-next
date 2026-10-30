import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('完整应用真实路由注册（隔离 MySQL）', () => {
  let app: INestApplication;
  let base: string;
  const names = ['DB_NAME', 'JWT_SECRET', 'DATA_ENCRYPTION_KEYS', 'DATA_ENCRYPTION_ACTIVE_KEY'];
  const before = Object.fromEntries(names.map(k => [k, process.env[k]]));
  beforeAll(async () => {
    process.env.DB_NAME = process.env.TEST_DB_NAME ?? 'kudesi_oa_test';
    process.env.JWT_SECRET = 'only-for-isolated-route-registration-tests-12345';
    process.env.DATA_ENCRYPTION_KEYS = 'route:' + Buffer.alloc(32, 9).toString('base64');
    process.env.DATA_ENCRYPTION_ACTIVE_KEY = 'route';
    const ds = await new DataSource({ ...buildDataSourceOptions(), migrationsRun: true } as never).initialize(); await ds.destroy();
    const { AppModule } = await import('../app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  }, 30000);
  afterAll(async () => {
    await app?.close();
    for (const k of names) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
  });
  it.each(['bundle-categories', 'cost-categories', 'sku-costs', 'bundle-codes'])('商品成本目录 %s 必须实际注册并拒绝无密钥访问', async path => {
    const r = await fetch(`${base}/api/external/catalog/v1/${path}`);
    expect(r.status).toBe(401); expect((await r.json()).statusCode).toBe(401);
  });
  it('普通商品上传及选项接口必须实际注册，并保留登录守卫', async () => {
    expect((await fetch(base + '/api/finance/jst-maintenance/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(base + '/api/finance/jst-maintenance/options')).status).toBe(401);
  });
  it('新的公司连接检查不允许匿名读取', async () => {
    expect((await fetch(base + '/api/settings/integrations/connections/jushuitan')).status).toBe(401);
    expect((await fetch(base + '/api/settings/integrations/connections/feishu')).status).toBe(401);
  });
});
