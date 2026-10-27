/**
 * B 组遗留项（历史负责人/聚水潭三级/手机号绑定店铺与导入/备忘到期视图）的真实数据库测试。
 *   RESOURCE_DB_TEST=1 TEST_DB_NAME=<库> npx jest --runInBand account-views
 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { addDaysText, todayShanghai } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const enabled = process.env.RESOURCE_DB_TEST === '1';
const d = enabled ? describe : describe.skip;

d('店铺与账号：实时视图与手机号导入（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  const today = todayShanghai();
  const filt = async (type: string, filters: Record<string, string>) => (await svc.list(boss, type, { filters: JSON.stringify(filters), pageSize: 100, showHidden: true })).items.map((i) => i.title);

  beforeAll(async () => {
    const options = buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' });
    ds = new DataSource({ ...options, migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `tv${crypto.randomBytes(4).toString('hex')}`, name: '测试公司V', status: 'active' }));
    const admin = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: admin.id, companyId: company.id, name: 'boss', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('历史负责人未指派 + 聚水潭三级到期筛选', async () => {
    await svc.create(boss, 'stores', { platform: 'pdd', name: '历史店', legacyOwnerName: '老张' });
    await svc.create(boss, 'stores', { platform: 'pdd', name: '聚过期', jushuitan: 'connected', jushuitanExpireAt: addDaysText(today, -3) });
    await svc.create(boss, 'stores', { platform: 'pdd', name: '聚10天', jushuitan: 'connected', jushuitanExpireAt: addDaysText(today, 10) });
    await svc.create(boss, 'stores', { platform: 'pdd', name: '聚25天', jushuitan: 'connected', jushuitanExpireAt: addDaysText(today, 25) });
    await svc.create(boss, 'stores', { platform: 'pdd', name: '未连接', jushuitan: 'not_connected', jushuitanExpireAt: addDaysText(today, -3) });
    expect(await filt('stores', { legacyOwner: 'unassigned' })).toEqual(['历史店']);
    expect(await filt('stores', { jstExpiry: 'expired' })).toEqual(['聚过期']);
    expect(await filt('stores', { jstExpiry: 'urgent' })).toEqual(['聚10天']);
    expect(await filt('stores', { jstExpiry: 'soon' })).toEqual(['聚25天']);
    await expect(filt('stores', { jstExpiry: 'nope' })).rejects.toThrow();
  });

  it('手机号：绑定店铺/主子卡派生、筛选、导入店铺列与号码规范化', async () => {
    await svc.create(boss, 'stores', { platform: 'pdd', name: '拼店A', storeNo: 'P001' });
    await svc.create(boss, 'stores', { platform: 'pdd', name: '拼店B', storeNo: 'P002' });
    await svc.create(boss, 'stores', { platform: 'tmall', name: '猫店', storeNo: 'T001' });
    const res = await svc.importRows(boss, 'phones', [
      { 号码: '="13900000001"', 使用类型: '公司保存', 拼多多编号: 'P001', 天猫店铺: '猫店' },
      { 号码: '1.3900000002E+10', 使用类型: '公司保存', 拼多多店铺: '不存在的店' },
    ], false);
    expect(res.failed).toBe(0);
    expect(res.results[1].warnings?.[0]).toContain('没有匹配到');
    const list = (await svc.list(boss, 'phones', { pageSize: 50 })).items;
    const p1 = list.find((p) => p.title === '13900000001')!;
    expect(p1.data.boundStores).toContain('拼多多·拼店A');
    expect(p1.data.boundStores).toContain('天猫·猫店');
    expect(p1.data.cardKind).toBe('主卡');
    expect(list.some((p) => p.title === '13900000002')).toBe(true);

    // 再导入：同平台换店 = 解绑原店
    await svc.importRows(boss, 'phones', [{ 号码: '13900000001', 使用类型: '公司保存', 拼多多店铺: '拼店B' }], false);
    const stores = (await svc.list(boss, 'stores', { pageSize: 50 })).items;
    expect(stores.find((s) => s.title === '拼店A')!.data.phoneId).toBeUndefined();
    expect(stores.find((s) => s.title === '拼店B')!.data.phoneId).toBe(p1.id);

    expect(await filt('phones', { storePlatform: 'pdd' })).toEqual(['13900000001']);
    expect(await filt('phones', { storePlatform: '__none' })).toEqual(['13900000002']);
    await svc.create(boss, 'phones', { number: '13900000003', usageType: 'company_kept', parentPhoneId: p1.id });
    expect(await filt('phones', { card: 'sub' })).toEqual(['13900000003']);
    expect((await filt('phones', { card: 'main' })).sort()).toEqual(['13900000001', '13900000002']);
  });

  it('手机号即将充值筛选；备忘 域名/即将到期/已过期 视图；店铺导入可按信用代码匹配执照', async () => {
    await svc.create(boss, 'phones', { number: '13900000010', usageType: 'company_kept', lastRechargeAt: addDaysText(today, -28), rechargeCycleDays: 30 });
    await svc.create(boss, 'phones', { number: '13900000011', usageType: 'company_kept', lastRechargeAt: today, rechargeCycleDays: 30 });
    expect(await filt('phones', { recharge: 'soon' })).toEqual(['13900000010']);

    await svc.create(boss, 'memos', { kind: 'service', title: 'qinghe.cn', provider: '阿里云', serviceType: '域名', endAt: addDaysText(today, 5) });
    await svc.create(boss, 'memos', { kind: 'service', title: '云服务器', provider: '阿里云', serviceType: '云服务器', endAt: addDaysText(today, -2) });
    await svc.create(boss, 'memos', { kind: 'account', title: '停用号', provider: 'X', endAt: addDaysText(today, -2) }, 'inactive');
    expect(await filt('memos', { memoView: 'domain' })).toEqual(['qinghe.cn']);
    expect(await filt('memos', { memoView: 'dueSoon' })).toEqual(['qinghe.cn']);
    expect(await filt('memos', { memoView: 'expired' })).toEqual(['云服务器']);

    const lic = await svc.create(boss, 'licenses', { category: 'operation', companyName: '青禾公司', creditCode: '91ABC0001', legalPerson: '张' });
    const r = await svc.importRows(boss, 'stores', [{ 平台: '拼多多', 店铺名: '执照店', 所属执照: '91abc0001' }], false);
    expect(r.failed).toBe(0);
    const st = (await svc.list(boss, 'stores', { keyword: '执照店' })).items[0];
    expect(st.data.licenseId).toBe(lic.id);
  });
});
