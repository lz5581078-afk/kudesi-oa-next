/**
 * 字段找回 B 组（店铺与账号）：读时派生字段、关联清单关键信息、旧手工领退店记录。需要：
 *   RESOURCE_DB_TEST=1 TEST_DB_NAME=<库> npx jest --runInBand accounts-fields-b
 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Department, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const enabled = process.env.RESOURCE_DB_TEST === '1';
const d = enabled ? describe : describe.skip;

d('店铺与账号字段找回（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let opId: number;
  let deptId: number;

  beforeAll(async () => {
    const options = buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' });
    ds = new DataSource({ ...options, migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `fb${crypto.randomBytes(4).toString('hex')}`, name: '测试公司FB', status: 'active' }));
    const dept = await ds.manager.save(Department, ds.manager.create(Department, { companyId: company.id, parentId: null, name: '短视频部', sortOrder: 1 } as never));
    deptId = dept.id;
    const admin = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    const op = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'op', passwordHash: 'x', name: '小运营', departmentId: dept.id, status: 'active', mustChangePassword: false, isCompanyAdmin: false }));
    boss = { id: admin.id, companyId: company.id, name: 'boss', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    opId = op.id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('自媒体：运营部门取自运营人当前部门，账号属性是当前平台专属字段的摘要，平台属性按平台保存', async () => {
    const sm = await svc.create(boss, 'self-media', { platform: 'douyin', name: '种子号', operatorUserId: opId, douyinShopId: 'D-1', bindPhone: '13900000000', contentCategory: '短剧', wechatId: '不属于抖音' });
    const got = await svc.get(boss, 'self-media', sm.id);
    expect(got.data.operatorDeptId).toBe(deptId);
    expect(got.refLabels.operatorDeptId).toBe('短视频部');
    expect(got.data.propSummary).toBe('抖店ID：D-1 / 平台绑定手机号：13900000000');
    expect(got.data.wechatId).toBeUndefined(); // 别的平台的属性服务端清掉
    const list = await svc.list(boss, 'self-media', { page: 1, pageSize: 20 });
    expect(list.items.find((x) => x.id === sm.id)?.data.operatorDeptId).toBe(deptId);
    // 没有运营人：没有部门
    const none = await svc.create(boss, 'self-media', { platform: 'xhs', name: '无人号' });
    expect((await svc.get(boss, 'self-media', none.id)).data.operatorDeptId).toBeUndefined();
  });

  it('备忘：负责人部门、密码“已维护/未设置”；服务可记手填归属账号', async () => {
    const m = await svc.create(boss, 'memos', { kind: 'service', title: '域名 a.com', provider: '阿里云', ownerUserId: opId, accountName: '主账号', password: 'x-secret' });
    const got = await svc.get(boss, 'memos', m.id);
    expect(got.data.ownerDeptId).toBe(deptId);
    expect(got.data.passwordState).toBe('已维护');
    expect(got.data.password).toBeUndefined();
    const m2 = await svc.create(boss, 'memos', { kind: 'account', title: '无密码账号', provider: '某平台', accountName: '不该留' });
    const got2 = await svc.get(boss, 'memos', m2.id);
    expect(got2.data.passwordState).toBe('未设置');
    expect(got2.data.accountName).toBeUndefined();
  });

  it('手机号：按平台拆开的店铺列、绑定的自媒体与微信；店铺的关联清单带对方关键信息', async () => {
    const ph = await svc.create(boss, 'phones', { number: '13600000001', usageType: 'company_kept' });
    const pdd = await svc.create(boss, 'stores', { platform: 'pdd', name: '拼店', storeNo: 'S-1', phoneId: ph.id });
    await svc.create(boss, 'stores', { platform: 'taobao', name: '淘店', phoneId: ph.id });
    await svc.create(boss, 'self-media', { platform: 'kuaishou', name: '快手号', phoneId: ph.id });
    await svc.create(boss, 'wechat', { name: '微信A', wechatNo: 'wx_fb_1', phoneId: ph.id });
    const got = await svc.get(boss, 'phones', ph.id);
    expect(got.data.storesPdd).toBe('拼店');
    expect(got.data.storesTaobao).toBe('淘店');
    expect(got.data.storesTmall).toBeUndefined();
    expect(got.data.boundStores).toContain('拼多多·拼店');
    expect(got.data.boundAccounts).toBe('快手·快手号、微信·微信A');
    const rels = await svc.relations(boss, 'stores', pdd.id, () => true);
    const toPhone = rels.find((r) => r.type === 'phones');
    expect(toPhone).toMatchObject({ direction: 'out', relationLabel: '手机号档案', title: '13600000001' });
    expect(toPhone?.summary).toContain('公司保存');
  });

  it('店铺：最后订单时刻只在有日期时保留；手工领退店记录可记（旧库迁入）', async () => {
    const s = await svc.create(boss, 'stores', { platform: 'jd', name: '时刻店', lastOrderAt: '2026-08-17', lastOrderClock: '10:08:30' });
    expect((await svc.get(boss, 'stores', s.id)).data.lastOrderClock).toBe('10:08:30');
    await expect(svc.update(boss, 'stores', s.id, { lastOrderClock: '25:00' })).rejects.toThrow(/时刻格式/);
    const cleared = await svc.update(boss, 'stores', s.id, { lastOrderAt: null });
    expect(cleared.data.lastOrderClock).toBeUndefined();
    const c = await svc.create(boss, 'store-claims', { storeId: s.id, action: 'manual', happenedAt: '2026-08-17', product: '水稻', note: '转化率低' });
    expect(c.data.action).toBe('manual');
  });

  it('手机号固定充值日：月付 1-31、年付 月-日，格式不对拒绝', async () => {
    const a = await svc.create(boss, 'phones', { number: '13600000002', usageType: 'company_kept', rechargeDay: '27' });
    expect(a.data.rechargeDay).toBe('27');
    const b = await svc.create(boss, 'phones', { number: '13600000003', usageType: 'company_kept', rechargeDay: '03-15' });
    expect(b.data.rechargeDay).toBe('03-15');
    await expect(svc.create(boss, 'phones', { number: '13600000004', usageType: 'company_kept', rechargeDay: '32' })).rejects.toThrow(/固定充值日|几号/);
  });
});
