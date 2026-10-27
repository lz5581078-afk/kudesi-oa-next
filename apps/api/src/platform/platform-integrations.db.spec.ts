/** 平台级接口应用配置的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=... npx jest platform-integrations */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { buildServices } from '../test-support';
import { PlatformIntegrationService } from './platform-integrations.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('平台级接口应用配置（真实数据库）', () => {
  let ds: DataSource, svc: PlatformIntegrationService;
  const admin = { id: 1, name: '平台', account: 'root' };
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = new PlatformIntegrationService(ds, buildServices(ds).crypto);
    await ds.query("DELETE FROM platform_integration_apps WHERE integration_key = 'hikvision'");
  });
  afterAll(async () => { await ds?.query("DELETE FROM platform_integration_apps WHERE integration_key = 'hikvision'"); await ds?.destroy(); });

  it('新增要 Key 和 Secret；密文入库；列表只给脱敏 Key，不给 Secret；留空不改', async () => {
    await expect(svc.save(admin, { integrationKey: 'nope', environment: 'production', appKey: 'a', appSecret: 'b' })).rejects.toThrow(/接口类型/);
    await expect(svc.save(admin, { integrationKey: 'hikvision', environment: 'dev', appKey: 'a', appSecret: 'b' })).rejects.toThrow(/环境/);
    await expect(svc.save(admin, { integrationKey: 'hikvision', environment: 'sandbox', appKey: 'only-key' })).rejects.toThrow(/都要填/);
    await expect(svc.save(admin, { integrationKey: 'hikvision', environment: 'sandbox', appKey: 'k', appSecret: 's', baseUrl: 'ftp://x' })).rejects.toThrow(/http/);
    const list = await svc.save(admin, { integrationKey: 'hikvision', environment: 'sandbox', appKey: 'APPKEY-1234567890', appSecret: 'SECRET-abcdef', baseUrl: 'https://api.example.com/' });
    const row = list.find((r) => r.integrationKey === 'hikvision')!;
    expect(row).toMatchObject({ environment: 'sandbox', appKeyMasked: 'APP**********7890', secretConfigured: true, baseUrl: 'https://api.example.com', status: 'active' });
    expect(JSON.stringify(list)).not.toContain('SECRET-abcdef');
    expect(JSON.stringify(list)).not.toContain('APPKEY-1234567890');
    const [raw] = await ds.query("SELECT app_key_enc, app_secret_enc FROM platform_integration_apps WHERE integration_key = 'hikvision'");
    expect(raw.app_key_enc + raw.app_secret_enc).not.toMatch(/APPKEY|SECRET-abcdef/);
    // 只改备注和状态：密钥保持
    await svc.save(admin, { integrationKey: 'hikvision', environment: 'sandbox', status: 'disabled', remark: '暂停' });
    expect(await svc.credentials('hikvision', 'sandbox')).toBeNull(); // 停用后不给出凭据
    await svc.save(admin, { integrationKey: 'hikvision', environment: 'sandbox', status: 'active' });
    expect(await svc.credentials('hikvision', 'sandbox')).toEqual({ appKey: 'APPKEY-1234567890', appSecret: 'SECRET-abcdef', baseUrl: null });
    await svc.remove(row.id);
    await expect(svc.remove(row.id)).rejects.toThrow(/不存在/);
  });
});
