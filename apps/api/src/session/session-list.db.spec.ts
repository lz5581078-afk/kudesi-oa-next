/** 店铺提现的店铺列表（搜索/筛选/排序/分页/进度）与授权电脑的升级、删除记录。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_d npx jest session-list */
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

d('店铺提现列表与授权电脑（真实数据库）', () => {
  let ds: DataSource, svc: SessionService, maint: MaintenanceService;
  let boss: AuthUser, viewer: AuthUser, outsider: AuthUser;
  const ids: Record<string, number> = {};
  const oldVersion = process.env.KUDESI_AGENT_LATEST_VERSION;

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    await alignSessionTimeZone(ds);
    const s = buildServices(ds);
    svc = new SessionService(ds, s.crypto, s.files);
    maint = new MaintenanceService(ds, s.crypto, s.files, s.resources);
    const mk = async (code: string) => {
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `${code}${crypto.randomBytes(5).toString('hex')}`, name: '列表测试', status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
      return { c, u, au: { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser };
    };
    const a = await mk('l'); boss = a.au;
    outsider = (await mk('m')).au;
    viewer = { ...boss, name: '看的人', permissions: { isCompanyAdmin: false, allow: ['finance.doc-withdrawal.view'], deny: [] } };
    const op = await ds.manager.save(User, ds.manager.create(User, { companyId: a.c.id, account: 'op', passwordHash: 'x', name: '小王', status: 'active', mustChangePassword: false }));
    const mkStore = async (name: string, platform: string, extra: Record<string, unknown> = {}) => (await s.resources.create(boss, 'stores', { name, platform, ...extra })).id;
    ids.pdd1 = await mkStore('拼多多甲店', 'pdd', { storeNo: 'S001', platformStoreId: 'PID-111', claimStatus: 'claimed', operatorUserId: op.id });
    ids.pdd2 = await mkStore('拼多多乙店', 'pdd', { storeNo: 'S002', platformStoreId: 'PID-222' });
    ids.tb = await mkStore('淘宝丙店', 'taobao', { storeNo: 'S003' });
    ids.dy = await mkStore('抖音丁店', 'douyin', { storeNo: 'S004' });
  });
  afterAll(async () => { process.env.KUDESI_AGENT_LATEST_VERSION = oldVersion; if (oldVersion === undefined) delete process.env.KUDESI_AGENT_LATEST_VERSION; await ds?.destroy(); });

  const pair = async (name: string, version = '1.0.0') => {
    const { code } = await svc.createBindCode(boss);
    return svc.agentRegister({ code, name, os: 'Windows 11', agentVersion: version });
  };

  it('列表：平台店铺ID、当前运营、最近打开、进度；搜索/筛选/排序/分页', async () => {
    const dev = await pair('财务电脑');
    await svc.agentHeartbeat(dev.token, {});
    await svc.addShops(boss, { storeIds: [ids.pdd1, ids.pdd2, ids.tb, ids.dy], deviceId: dev.deviceId });
    const first = await svc.overview(boss);
    expect(first).toMatchObject({ total: 4, page: 1, pageCount: 1 });
    const a = first.shops.find((x) => x.storeId === ids.pdd1)!;
    expect(a).toMatchObject({ platformStoreId: 'PID-111', storeNo: 'S001', operatorName: '小王', platformLabel: '拼多多', lastOpenedAt: null, request: null });
    // 进度：请求中 → 等待助手领取；领取后 → 处理中；成功 → 100% 且有最近打开时间
    const req = await svc.requestOpen(boss, a.id);
    expect((await svc.overview(boss)).shops.find((x) => x.id === a.id)!.request).toMatchObject({ status: 'pending', percent: 10, step: '等待助手领取' });
    await svc.agentClaim(dev.token);
    expect((await svc.overview(boss)).shops.find((x) => x.id === a.id)!.request).toMatchObject({ status: 'claimed', percent: 60 });
    await svc.agentReport(dev.token, req.id, { status: 'succeeded' });
    const done = (await svc.overview(boss)).shops.find((x) => x.id === a.id)!;
    expect(done.request).toMatchObject({ status: 'succeeded', percent: 100 });
    expect(done.lastOpenedAt).not.toBeNull();
    // 搜索：店铺名、编码、平台店铺ID、运营、平台
    const kw = async (k: string) => (await svc.overview(boss, { keyword: k })).shops.map((x) => x.storeName);
    expect(await kw('甲')).toEqual(['拼多多甲店']);
    expect(await kw('pid-222')).toEqual(['拼多多乙店']);
    expect(await kw('S003')).toEqual(['淘宝丙店']);
    expect(await kw('小王')).toEqual(['拼多多甲店']);
    expect((await kw('拼多多')).length).toBe(2);
    expect(await kw('不存在的')).toEqual([]);
    // 筛选
    expect((await svc.overview(boss, { loginState: 'valid' })).shops.map((x) => x.storeName)).toEqual(['拼多多甲店']);
    expect((await svc.overview(boss, { loginState: 'none' })).total).toBe(3);
    expect((await svc.overview(boss, { deviceId: String(dev.deviceId) })).total).toBe(4);
    expect((await svc.overview(boss, { deviceId: 'none' })).total).toBe(0);
    expect((await svc.overview(boss, { storeStatus: 'abnormal' })).total).toBe(0);
    // 排序：按平台（拼多多、淘宝、抖音）；按运营（有运营的在前，没有运营的永远最后）
    expect((await svc.overview(boss, { sort: 'platform_asc' })).shops.map((x) => x.platform)).toEqual(['pdd', 'pdd', 'taobao', 'douyin']);
    expect((await svc.overview(boss, { sort: 'platform_desc' })).shops.map((x) => x.platform)).toEqual(['douyin', 'taobao', 'pdd', 'pdd']);
    expect((await svc.overview(boss, { sort: 'operator_asc' })).shops[0].operatorName).toBe('小王');
    expect((await svc.overview(boss, { sort: 'operator_desc' })).shops[0].operatorName).toBe('小王');
    // 分页：每页最少 10，越界页回到最后一页
    const many: number[] = [];
    for (let i = 0; i < 12; i++) many.push((await buildServices(ds).resources.create(boss, 'stores', { name: `批量店${String(i).padStart(2, '0')}`, platform: 'jd' })).id);
    await svc.addShops(boss, { storeIds: many, deviceId: dev.deviceId });
    const p1 = await svc.overview(boss, { pageSize: 10, sort: 'default' });
    expect(p1).toMatchObject({ total: 16, page: 1, pageSize: 10, pageCount: 2 });
    expect(p1.shops).toHaveLength(10);
    const p9 = await svc.overview(boss, { pageSize: 10, page: 9 });
    expect(p9.page).toBe(2);
    expect(p9.shops).toHaveLength(6);
    // 公司店铺维护共用同一套列表
    expect((await maint.overview(boss, {})).total).toBe(0);
    await expect(svc.availableStores(viewer)).rejects.toThrow(/权限/);
    // 别的公司看不到
    expect((await svc.overview(outsider)).total).toBe(0);
  });

  it('授权电脑：升级安排（需要配置了最新版）、升到目标版本后自动成功；删除记录只能删已撤销且无负责店铺的电脑', async () => {
    const dev = await pair('旧电脑', '1.0.0');
    delete process.env.KUDESI_AGENT_LATEST_VERSION;
    await expect(svc.requestDeviceUpdate(boss, dev.deviceId)).rejects.toThrow(/暂未发布新版/);
    process.env.KUDESI_AGENT_LATEST_VERSION = '1.2.0';
    let row = (await svc.devices(boss)).find((x) => x.id === dev.deviceId)!;
    expect(row).toMatchObject({ outdated: true, latestVersion: '1.2.0', update: null });
    await expect(svc.requestDeviceUpdate(viewer, dev.deviceId)).rejects.toThrow(/权限/);
    await expect(svc.requestUpdateAll(viewer)).rejects.toThrow(/权限/);
    await expect(svc.requestDeviceUpdate(outsider, dev.deviceId)).rejects.toThrow(/不存在/);
    expect(await svc.requestDeviceUpdate(boss, dev.deviceId)).toMatchObject({ queued: true, target: '1.2.0' });
    row = (await svc.devices(boss)).find((x) => x.id === dev.deviceId)!;
    expect(row.update).toMatchObject({ target: '1.2.0', status: 'queued' });
    // 助手心跳拿到升级安排；升到目标版本后标记成功
    expect((await svc.agentHeartbeat(dev.token, { agentVersion: '1.0.0' })).update).toEqual({ targetVersion: '1.2.0' });
    expect((await svc.agentHeartbeat(dev.token, { agentVersion: '1.2.0' })).update).toBeNull();
    row = (await svc.devices(boss)).find((x) => x.id === dev.deviceId)!;
    expect(row).toMatchObject({ outdated: false, agentVersion: '1.2.0' });
    expect(row.update?.status).toBe('succeeded');
    expect(await svc.requestDeviceUpdate(boss, dev.deviceId)).toMatchObject({ queued: false, alreadyCurrent: true });
    // 一键升级所有过期的电脑
    const d2 = await pair('旧电脑2', '1.1.0');
    expect(await svc.requestUpdateAll(boss)).toMatchObject({ target: '1.2.0' });
    expect((await svc.devices(boss)).find((x) => x.id === d2.deviceId)!.update?.status).toBe('queued');

    // 删除记录
    const shopDev = await pair('有店铺的电脑');
    const keep = (await buildServices(ds).resources.create(boss, 'stores', { name: '挂在旧电脑的店', platform: 'pdd' })).id;
    await svc.addShops(boss, { storeIds: [keep], deviceId: shopDev.deviceId });
    await expect(svc.deleteDevice(boss, shopDev.deviceId)).rejects.toThrow(/先撤销/);
    await svc.setDeviceStatus(boss, shopDev.deviceId, 'revoked');
    await expect(svc.deleteDevice(boss, shopDev.deviceId)).rejects.toThrow(/负责 1 家店铺/);
    const shop = (await svc.overview(boss, { keyword: '挂在旧电脑' })).shops[0];
    await svc.updateShop(boss, shop.id, { deviceId: dev.deviceId });
    await expect(svc.deleteDevice(viewer, shopDev.deviceId)).rejects.toThrow(/权限/);
    await expect(svc.deleteDevice(outsider, shopDev.deviceId)).rejects.toThrow(/不存在/);
    await svc.deleteDevice(boss, shopDev.deviceId);
    expect((await svc.devices(boss)).some((x) => x.id === shopDev.deviceId)).toBe(false);
    await expect(svc.setDeviceStatus(boss, shopDev.deviceId, 'active')).rejects.toThrow(/不存在/); // 删了就不能再恢复
    await expect(svc.agentHeartbeat(shopDev.token, {})).rejects.toThrow(/未授权/);
    // 恢复仍然可用（撤销的电脑，没删）
    await svc.setDeviceStatus(boss, d2.deviceId, 'revoked');
    await svc.setDeviceStatus(boss, d2.deviceId, 'active');
    expect((await svc.devices(boss)).find((x) => x.id === d2.deviceId)!.status).toBe('active');
  });
});
