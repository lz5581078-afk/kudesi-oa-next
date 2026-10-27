/**
 * 资料专属页的列表配置（真实数据库）：店铺五个快捷页签与带原因批量指派/收回、税务店铺数/本月营业额与执照情况、
 * 微信号手机号档案筛选、职责组没有成员页签与成员数/职责数、备忘域名页签。
 *   RESOURCE_DB_TEST=1 TEST_DB_NAME=<库> npx jest --runInBand panels-config
 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { todayShanghai } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const enabled = process.env.RESOURCE_DB_TEST === '1';
const d = enabled ? describe : describe.skip;

d('资料专属页列表配置（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let staffId: number;

  beforeAll(async () => {
    const options = buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' });
    ds = new DataSource({ ...options, migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `pc${crypto.randomBytes(4).toString('hex')}`, name: '专属页配置公司', status: 'active' }));
    const admin = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    const staff = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'op', passwordHash: 'x', name: '小运营', isCompanyAdmin: false, status: 'active', mustChangePassword: false }));
    boss = { id: admin.id, companyId: company.id, name: 'boss', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser;
    staffId = staff.id;
  });
  afterAll(async () => { await ds?.destroy(); });

  const names = async (type: string, tab: string) => (await svc.list(boss, type, { tab, pageSize: 100, showHidden: true })).items.map((i) => i.title).sort();

  it('店铺：五个快捷页签；批量指派带原因并变已领取；批量收回清空运营人', async () => {
    const pub = await svc.create(boss, 'stores', { platform: 'pdd', name: '公共店' });
    const op = await svc.create(boss, 'stores', { platform: 'pdd', name: '运营店', operatorUserId: staffId, claimStatus: 'claimed' });
    const legacy = await svc.create(boss, 'stores', { platform: 'pdd', name: '历史店', legacyOwnerName: '老张' });
    const abn = await svc.create(boss, 'stores', { platform: 'pdd', name: '异常店', operatorUserId: staffId, claimStatus: 'claimed' });
    await svc.changeStatus(boss, 'stores', abn.id, 'abnormal', '测试');
    const gone = await svc.create(boss, 'stores', { platform: 'pdd', name: '注销店' });
    await svc.changeStatus(boss, 'stores', gone.id, 'cancelled', '关店');
    expect(await names('stores', 'q:operating')).toEqual(['异常店', '运营店']);
    expect(await names('stores', 'q:legacy-owner')).toEqual(['历史店']);
    expect(await names('stores', 'q:public')).toEqual(['公共店', '历史店']);
    expect(await names('stores', 'q:abnormal')).toEqual(['异常店']);
    expect(await names('stores', 'q:cancelled')).toEqual(['注销店']);

    await expect(svc.batchAction(boss, 'stores', [pub.id], 'assign', staffId, '')).rejects.toThrow(/指派原因/);
    const r = await svc.batchAction(boss, 'stores', [pub.id, legacy.id], 'assign', staffId, '新员工接手');
    expect(r.done).toBe(2);
    const after = await svc.get(boss, 'stores', pub.id);
    expect(after.data.operatorUserId).toBe(staffId);
    expect(after.data.claimStatus).toBe('claimed');
    expect(JSON.stringify(await svc.logs(boss, 'stores', pub.id))).toContain('新员工接手');
    expect(await names('stores', 'q:legacy-owner')).toEqual([]);

    const rel = await svc.batchAction(boss, 'stores', [op.id], 'release', undefined, '运营离职');
    expect(rel.done).toBe(1);
    const released = await svc.get(boss, 'stores', op.id);
    expect(released.data.operatorUserId ?? null).toBeNull();
    expect(released.data.claimStatus).toBe('public');
  });

  it('税务：店铺数、本月营业额、执照情况筛选', async () => {
    const lic1 = await svc.create(boss, 'licenses', { category: 'operation', companyName: '甲公司', creditCode: 'P00000000000000001', legalPerson: '张三' });
    const lic2 = await svc.create(boss, 'licenses', { category: 'operation', companyName: '乙公司', creditCode: 'P00000000000000002', legalPerson: '李四' });
    await svc.changeStatus(boss, 'licenses', lic2.id, 'inactive', '停用');
    const s1 = await svc.create(boss, 'stores', { platform: 'pdd', name: '税店1', licenseId: lic1.id });
    await svc.create(boss, 'stores', { platform: 'pdd', name: '税店2', licenseId: lic1.id });
    await svc.create(boss, 'store-daily-metrics', { storeId: s1.id, day: todayShanghai(), sales: 5000 });
    await svc.create(boss, 'store-daily-metrics', { storeId: s1.id, day: '2001-01-01', sales: 7000 });
    const ensure = async (licenseId: number, name: string) => {
      const have = (await svc.list(boss, 'tax-profiles', { pageSize: 100, showHidden: true })).items.find((x) => x.data.licenseId === licenseId);
      return have ?? svc.create(boss, 'tax-profiles', { licenseId, taxCategory: 'operation', taxpayerName: name });
    };
    const t1 = await ensure(lic1.id, '甲税');
    const t2 = await ensure(lic2.id, '乙税');
    const rows = (await svc.list(boss, 'tax-profiles', { pageSize: 100, showHidden: true })).items;
    expect(rows.find((x) => x.id === t1.id)!.data.storeCount).toBe(2);
    expect(rows.find((x) => x.id === t1.id)!.data.monthSales).toBe(5000);
    const closed = (await svc.list(boss, 'tax-profiles', { filters: JSON.stringify({ licenseState: 'closed' }), pageSize: 100, showHidden: true })).items.map((i) => i.id);
    expect(closed).toContain(t2.id);
    expect(closed).not.toContain(t1.id);
  });

  it('微信号：手机号档案已关联/未关联', async () => {
    const phone = await svc.create(boss, 'phones', { number: '13600136000', usageType: 'company_kept' });
    const w1 = await svc.create(boss, 'wechat', { name: '关联号', wechatNo: 'wx_link_1', phoneId: phone.id });
    const w2 = await svc.create(boss, 'wechat', { name: '未关联号', wechatNo: 'wx_free_2' });
    const f = async (v: string) => (await svc.list(boss, 'wechat', { filters: JSON.stringify({ phoneArchive: v }), pageSize: 100, showHidden: true })).items.map((i) => i.id);
    expect(await f('linked')).toContain(w1.id);
    expect(await f('linked')).not.toContain(w2.id);
    expect(await f('unlinked')).toContain(w2.id);
    expect(await f('unlinked')).not.toContain(w1.id);
  });

  it('职责组：没有成员页签、成员数/职责数；备忘：域名页签', async () => {
    const g1 = await svc.create(boss, 'duty-groups', { groupKey: 'g_with', name: '有成员组', scope: 'company' });
    const g2 = await svc.create(boss, 'duty-groups', { groupKey: 'g_empty', name: '空组', scope: 'company' });
    await svc.create(boss, 'duty-group-members', { groupId: g1.id, userId: staffId });
    await svc.create(boss, 'duty-group-items', { groupId: g1.id, title: '审核售后' });
    expect(await names('duty-groups', 'q:empty')).toEqual(['空组']);
    const rows = (await svc.list(boss, 'duty-groups', { pageSize: 100, showHidden: true })).items;
    expect(rows.find((x) => x.id === g1.id)!.data.memberCount).toBe(1);
    expect(rows.find((x) => x.id === g1.id)!.data.itemCount).toBe(1);
    expect(rows.find((x) => x.id === g2.id)!.data.memberCount).toBe(0);

    await svc.create(boss, 'memos', { kind: 'service', title: 'qinghe.cn', provider: '阿里云', serviceType: '域名' });
    await svc.create(boss, 'memos', { kind: 'service', title: '服务器', provider: '腾讯云', serviceType: '云服务器' });
    await svc.create(boss, 'memos', { kind: 'account', title: '账号', provider: '阿里云', serviceType: '域名' });
    expect(await names('memos', 'q:domain')).toEqual(['qinghe.cn']);
  });

  it('备忘即将到期/已过期页签；自媒体按运营人所在部门筛选（含下级部门）', async () => {
    const addDays = (n: number) => new Date(Date.now() + 8 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
    await svc.create(boss, 'memos', { kind: 'service', title: '快到期服务', provider: 'P', endAt: addDays(10) });
    await svc.create(boss, 'memos', { kind: 'service', title: '很久后服务', provider: 'P', endAt: addDays(200) });
    await svc.create(boss, 'memos', { kind: 'service', title: '已过期服务', provider: 'P', endAt: addDays(-3) });
    await svc.create(boss, 'memos', { kind: 'service', title: '没填日期', provider: 'P' });
    expect(await names('memos', 'q:due-soon')).toEqual(['快到期服务']);
    expect(await names('memos', 'q:expired')).toEqual(['已过期服务']);

    const { Department } = await import('../entities');
    const top = await ds.manager.save(Department, ds.manager.create(Department, { companyId: boss.companyId, name: '运营中心', sortOrder: 10, status: 'active' } as never)) as { id: number };
    const sub = await ds.manager.save(Department, ds.manager.create(Department, { companyId: boss.companyId, name: '抖音组', parentId: top.id, sortOrder: 10, status: 'active' } as never)) as { id: number };
    await ds.manager.update(User, { id: staffId }, { departmentId: sub.id } as never);
    const mine = await svc.create(boss, 'self-media', { platform: 'douyin', name: '抖音号A', operatorUserId: staffId });
    const nobody = await svc.create(boss, 'self-media', { platform: 'douyin', name: '无人号' });
    const f = async (v: number) => (await svc.list(boss, 'self-media', { filters: JSON.stringify({ operatorDept: String(v) }), pageSize: 100, showHidden: true })).items.map((i) => i.id);
    expect(await f(top.id)).toContain(mine.id);
    expect(await f(sub.id)).toContain(mine.id);
    expect(await f(top.id)).not.toContain(nobody.id);
  });
});
