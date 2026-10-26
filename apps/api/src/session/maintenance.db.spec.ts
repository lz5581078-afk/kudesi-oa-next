/** 公司店铺维护的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test npx jest maintenance */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { alignSessionTimeZone, buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { MaintenanceService } from './maintenance.service';
import { SessionService } from './session.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('公司店铺维护（真实数据库）', () => {
  let ds: DataSource, m: MaintenanceService, w: SessionService, res: ReturnType<typeof buildServices>['resources'];
  let boss: AuthUser, viewer: AuthUser, dev: { deviceId: number; token: string };
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    await alignSessionTimeZone(ds);
    const s = buildServices(ds);
    res = s.resources;
    m = new MaintenanceService(ds, s.crypto, s.files, res);
    w = new SessionService(ds, s.crypto, s.files);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `m${crypto.randomBytes(5).toString('hex')}`, name: '维护测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    viewer = { ...boss, permissions: { isCompanyAdmin: false, allow: ['resource.company-store-maintenance.view'], deny: [] } };
    ids.store = (await res.create(boss, 'stores', { platform: 'pdd', name: '维护店A' })).id;
    ids.cancelled = (await res.create(boss, 'stores', { platform: 'pdd', name: '维护店B' })).id;
    await res.changeStatus(boss, 'stores', ids.cancelled, 'cancelled', '关店');
    const { code } = await w.createBindCode(boss);
    dev = await w.agentRegister({ code, name: '维护电脑' });
  });
  afterAll(async () => { await ds?.destroy(); });

  it('清单和店铺提现互相独立；异常/注销的店铺也能加入维护清单', async () => {
    await expect(m.addShops(viewer, { storeIds: [ids.store], deviceId: dev.deviceId })).rejects.toThrow(/权限/);
    expect((await m.availableStores(boss)).map((x) => x.name).sort()).toEqual(['维护店A', '维护店B']);
    await m.addShops(boss, { storeIds: [ids.store, ids.cancelled], deviceId: dev.deviceId });
    expect((await m.overview(boss)).shops).toHaveLength(2);
    expect((await w.overview(boss)).shops).toHaveLength(0);
    expect((await m.overview(viewer)).canManage).toBe(false);
  });

  it('改店铺状态：异常必须选原因库里的原因；正常后原因清掉；写入变更记录', async () => {
    const shop = (await m.overview(boss)).shops.find((x) => x.storeId === ids.store)!;
    await expect(m.setStoreStatus(viewer, shop.id, { status: 'normal' })).rejects.toThrow(/权限/);
    await expect(m.setStoreStatus(boss, shop.id, { status: 'abnormal' })).rejects.toThrow(/必须选择异常原因/);
    await expect(m.setStoreStatus(boss, shop.id, { status: 'abnormal', abnormalReasonId: 999999 })).rejects.toThrow(/已有的异常原因/);
    const r = await res.create(boss, 'store-abnormal-reasons', { reason: '店铺被限流' });
    expect((await m.abnormalReasons(boss)).map((x) => x.reason)).toContain('店铺被限流');
    await m.setStoreStatus(boss, shop.id, { status: 'abnormal', abnormalReasonId: r.id });
    const st = await res.get(boss, 'stores', ids.store);
    expect(st.status).toBe('abnormal');
    expect(st.data.abnormalReason).toBe(r.id);
    await m.setStoreStatus(boss, shop.id, { status: 'normal' });
    const back = await res.get(boss, 'stores', ids.store);
    expect(back.status).toBe('normal');
    expect(back.data.abnormalReason).toBeUndefined();
    await expect(m.setStoreStatus(boss, 999999, { status: 'normal' })).rejects.toThrow(/不在公司店铺维护清单/);
    await expect(m.setStoreStatus(boss, shop.id, { status: 'cancelled' })).rejects.toThrow(/原因/);
  });
});
