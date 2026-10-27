/**
 * 资料配置里的声明式能力：快捷页签、计算筛选、派生列、带原因的批量动作、所有资料的批量停用/启用（真实数据库）。
 *   RESOURCE_DB_TEST=1 TEST_DB_NAME=<库> npx jest --runInBand def-conditions
 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { getResourceDef, todayShanghai, type ResourceDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const enabled = process.env.RESOURCE_DB_TEST === '1';
const d = enabled ? describe : describe.skip;

d('资料配置：快捷页签 / 计算筛选 / 派生列 / 批量动作（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let other: AuthUser;
  const stores = getResourceDef('stores') as ResourceDef & Record<string, unknown>;
  const tax = getResourceDef('tax-profiles') as ResourceDef & Record<string, unknown>;
  const saved = { stores: { ...stores }, tax: { ...tax } };

  beforeAll(async () => {
    const options = buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' });
    ds = new DataSource({ ...options, migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const mk = async (name: string) => {
      const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `dc${crypto.randomBytes(4).toString('hex')}`, name, status: 'active' }));
      const admin = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
      return { id: admin.id, companyId: company.id, name: 'boss', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser;
    };
    boss = await mk('条件测试公司');
    other = await mk('别家公司');
  });
  afterAll(async () => {
    Object.assign(stores, saved.stores);
    Object.assign(tax, saved.tax);
    await ds?.destroy();
  });

  it('快捷页签：字段为空/状态/按关联存在，数量一致，隐藏状态页签可看已注销', async () => {
    stores.quickTabs = [
      { key: 'unassigned', label: '公共待领取', when: { all: [{ field: 'operatorUserId', op: 'empty' }, { field: '$status', op: 'ne', value: 'cancelled' }] } },
      { key: 'abnormal', label: '异常', when: { field: '$status', op: 'eq', value: 'abnormal' } },
      { key: 'cancelled', label: '已注销', when: { field: '$status', op: 'eq', value: 'cancelled' }, includeHidden: true },
    ];
    const a = await svc.create(boss, 'stores', { platform: 'pdd', name: '无人店' });
    const b = await svc.create(boss, 'stores', { platform: 'pdd', name: '有人店', operatorUserId: boss.id });
    const c = await svc.create(boss, 'stores', { platform: 'pdd', name: '异常店', operatorUserId: boss.id });
    await svc.changeStatus(boss, 'stores', c.id, 'abnormal', '测试');
    const e = await svc.create(boss, 'stores', { platform: 'pdd', name: '注销店' });
    await svc.changeStatus(boss, 'stores', e.id, 'cancelled', '关店');
    await svc.create(other, 'stores', { platform: 'pdd', name: '别家无人店' });

    const names = async (tab: string) => (await svc.list(boss, 'stores', { tab, pageSize: 50 })).items.map((i) => i.title).sort();
    expect(await names('q:unassigned')).toEqual(['无人店']);
    expect(await names('q:abnormal')).toEqual(['异常店']);
    expect(await names('q:cancelled')).toEqual(['注销店']);
    const r = await svc.list(boss, 'stores', { pageSize: 50 });
    expect(r.tabCounts).toMatchObject({ 'q:unassigned': 1, 'q:abnormal': 1, 'q:cancelled': 1 });
    await expect(svc.list(boss, 'stores', { tab: 'q:nope' })).rejects.toThrow();
    void a; void b;
  });

  it('计算筛选与派生列：税务资料的店铺数、执照情况', async () => {
    tax.computedFilters = [{
      key: 'licenseView', label: '执照情况',
      options: [
        { value: 'none', label: '没有绑定营业执照', when: { field: 'licenseId', op: 'empty' } },
        { value: 'closed', label: '执照已停用或注销', when: { viaRef: 'licenseId', where: { field: '$status', op: 'in', value: ['inactive', 'cancelled'] } } },
      ],
    }];
    tax.derivedColumns = [
      { key: 'storeCount', label: '店铺数', kind: 'count', type: 'stores', field: 'licenseId', match: 'licenseId' },
      { key: 'monthSales', label: '执照本月营业额', kind: 'sum', type: 'store-daily-metrics', field: 'storeId', via: { type: 'stores', field: 'licenseId' }, match: 'licenseId', sumField: 'sales', month: 'day', format: 'money' },
    ];
    const lic1 = await svc.create(boss, 'licenses', { category: 'operation', companyName: '甲公司', creditCode: 'A00000000000000001', legalPerson: '张三' });
    const lic2 = await svc.create(boss, 'licenses', { category: 'operation', companyName: '乙公司', creditCode: 'A00000000000000002', legalPerson: '李四' });
    await svc.changeStatus(boss, 'licenses', lic2.id, 'inactive', '停用');
    const s1 = await svc.create(boss, 'stores', { platform: 'pdd', name: '甲店1', licenseId: lic1.id });
    await svc.create(boss, 'stores', { platform: 'pdd', name: '甲店2', licenseId: lic1.id });
    const today = todayShanghai();
    await svc.create(boss, 'store-daily-metrics', { storeId: s1.id, day: today, sales: 12345 });
    await svc.create(boss, 'store-daily-metrics', { storeId: s1.id, day: '2001-01-01', sales: 99999 });
    // 建执照时可能已自动带出税务资料：没有再建
    const ensure = async (licenseId: number, name: string) => {
      const have = (await svc.list(boss, 'tax-profiles', { pageSize: 50, showHidden: true })).items.find((x) => x.data.licenseId === licenseId);
      return have ?? svc.create(boss, 'tax-profiles', { licenseId, taxCategory: 'operation', taxpayerName: name });
    };
    const t1 = await ensure(lic1.id, '甲税');
    const t2 = await ensure(lic2.id, '乙税');

    const rows = (await svc.list(boss, 'tax-profiles', { pageSize: 50, showHidden: true })).items;
    const mine = rows.find((x) => x.id === t1.id)!;
    expect(mine.data.storeCount).toBe(2);
    expect(mine.data.monthSales).toBe(12345);
    expect(rows.find((x) => x.id === t2.id)!.data.storeCount).toBe(0);
    const f = async (v: string) => (await svc.list(boss, 'tax-profiles', { filters: JSON.stringify({ licenseView: v }), pageSize: 50, showHidden: true })).items.map((i) => i.title);
    const closed = (await svc.list(boss, 'tax-profiles', { filters: JSON.stringify({ licenseView: 'closed' }), pageSize: 50, showHidden: true })).items.map((i) => i.id);
    expect(closed).toContain(t2.id);
    expect(closed).not.toContain(t1.id);
    await expect(f('bogus')).rejects.toThrow();
  });

  it('按关联存在/不存在：有经营数据的店铺 / 没有经营数据的店铺', async () => {
    stores.quickTabs = [
      { key: 'hasMetrics', label: '有数据', when: { rel: { type: 'store-daily-metrics', field: 'storeId' }, op: 'exists' } },
      { key: 'noMetrics', label: '无数据', when: { rel: { type: 'store-daily-metrics', field: 'storeId', where: { field: 'sales', op: 'notEmpty' } }, op: 'none' } },
    ];
    const withData = await svc.create(boss, 'stores', { platform: 'pdd', name: '有数据店' });
    const without = await svc.create(boss, 'stores', { platform: 'pdd', name: '没数据店' });
    await svc.create(boss, 'store-daily-metrics', { storeId: withData.id, day: '2020-02-02', sales: 100 });
    const ids = async (tab: string) => (await svc.list(boss, 'stores', { tab, pageSize: 200 })).items.map((i) => i.id);
    expect(await ids('q:hasMetrics')).toContain(withData.id);
    expect(await ids('q:hasMetrics')).not.toContain(without.id);
    expect(await ids('q:noMetrics')).toContain(without.id);
    expect(await ids('q:noMetrics')).not.toContain(withData.id);
  });

  it('条件里的字段/类型不在配置里：拒绝（白名单）', async () => {
    stores.quickTabs = [{ key: 'bad', label: '坏', when: { field: 'nope', op: 'eq', value: 'x' } }];
    await expect(svc.list(boss, 'stores', { tab: 'q:bad' })).rejects.toThrow();
    stores.quickTabs = [{ key: 'bad2', label: '坏2', when: { rel: { type: 'no-such', field: 'x' }, op: 'exists' } }];
    await expect(svc.list(boss, 'stores', { tab: 'q:bad2' })).rejects.toThrow();
  });

  it('带原因的批量动作：写入选的值和原因字段，日志有原因；缺原因/未配置的动作被拒绝', async () => {
    stores.batchActions = [{ key: 'assign', label: '批量指派运营', pick: 'operatorUserId', reasonField: 'assignReason', reasonRequired: true, reasonLabel: '指派原因' }];
    const hasReasonField = stores.fields.some((f) => f.key === 'assignReason');
    const s1 = await svc.create(boss, 'stores', { platform: 'pdd', name: '批量1' });
    const s2 = await svc.create(boss, 'stores', { platform: 'pdd', name: '批量2' });
    await expect(svc.batchAction(boss, 'stores', [s1.id], 'assign', boss.id, '')).rejects.toThrow(/指派原因/);
    await expect(svc.batchAction(boss, 'stores', [s1.id], 'nope', boss.id, '原因')).rejects.toThrow();
    await expect(svc.batchAction(boss, 'stores', [s1.id], 'assign', undefined, '原因')).rejects.toThrow();
    if (!hasReasonField) { stores.batchActions = [{ key: 'assign', label: '批量指派运营', pick: 'operatorUserId', reasonRequired: true }]; }
    const r = await svc.batchAction(boss, 'stores', [s1.id, s2.id], 'assign', boss.id, '接手新品');
    expect(r.done).toBe(2);
    expect((await svc.get(boss, 'stores', s1.id)).data.operatorUserId).toBe(boss.id);
    const logs = await svc.logs(boss, 'stores', s2.id);
    expect(JSON.stringify(logs)).toContain('接手新品');
  });

  it('批量停用/启用：不配置 batch 也能用；只能停用或启用；别家公司的记录处理不到', async () => {
    const def = getResourceDef('phones')!;
    expect(def.batch ?? []).not.toContain('status');
    const p1 = await svc.create(boss, 'phones', { number: '13800001111', usageType: 'company_kept' });
    const foreign = await svc.create(other, 'phones', { number: '13800002222', usageType: 'company_kept' });
    const off = await svc.batchUpdate(boss, 'phones', [p1.id, foreign.id], {}, 'inactive', '不再使用');
    expect(off.done).toBe(1);
    expect(off.failed).toHaveLength(1);
    expect((await svc.get(boss, 'phones', p1.id)).status).toBe('inactive');
    expect((await svc.get(other, 'phones', foreign.id)).status).not.toBe('inactive');
    const on = await svc.batchUpdate(boss, 'phones', [p1.id], {}, def.defaultStatus, '恢复使用');
    expect(on.done).toBe(1);
    await expect(svc.batchUpdate(boss, 'phones', [p1.id], {}, 'abnormal', '乱改')).rejects.toThrow(/只能批量停用或启用/);
    await expect(svc.batchUpdate(boss, 'phones', [p1.id], { remark: 'x' }, undefined, undefined)).rejects.toThrow();
  });

  it('资料总览：停用/注销、已归档小计，只算本公司', async () => {
    const x = await svc.create(boss, 'phones', { number: '13700000001', usageType: 'company_kept' });
    const y = await svc.create(boss, 'phones', { number: '13700000002', usageType: 'company_kept' });
    await svc.changeStatus(boss, 'phones', x.id, 'inactive', '不用了');
    await svc.archive(boss, 'phones', y.id, '测试归档');
    const mine = (await svc.overview(boss)).items.find((i) => i.type === 'phones')!;
    expect(mine.inactive).toBeGreaterThanOrEqual(1);
    expect(mine.archived).toBeGreaterThanOrEqual(1);
    const foreign = (await svc.overview(other)).items.find((i) => i.type === 'phones')!;
    expect(foreign.archived).toBe(0);
  });

  it('“即将到期”列表：到期最早的排最前', async () => {
    const t = todayShanghai();
    const day = (n: number) => { const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const mk = (n: string, due: number) => svc.create(boss, 'licenses', { category: 'operation', companyName: `到期${n}`, creditCode: `E${n}`, legalPerson: '张', expiresAt: day(due) });
    const late = await mk('3', 20);
    const early = await mk('1', -2);
    const mid = await mk('2', 5);
    const r = await svc.list(boss, 'licenses', { expiring: true, pageSize: 50 });
    const order = r.items.map((i) => i.id).filter((id) => [late.id, early.id, mid.id].includes(id));
    expect(order).toEqual([early.id, mid.id, late.id]);
  });
});
