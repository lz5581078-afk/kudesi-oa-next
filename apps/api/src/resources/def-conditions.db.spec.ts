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
import { Company, Department, User } from '../entities';
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
    // 派生列可排序、可导出
    const asc = (await svc.list(boss, 'tax-profiles', { sortBy: 'storeCount', sortDir: 'asc', pageSize: 50, showHidden: true })).items.map((i) => i.data.storeCount);
    expect(asc).toEqual([...asc].sort((a, b) => Number(a) - Number(b)));
    const desc = (await svc.list(boss, 'tax-profiles', { sortBy: 'storeCount', sortDir: 'desc', pageSize: 50, showHidden: true })).items[0];
    expect(desc.data.storeCount).toBe(2);
    const csv = await svc.exportCsv(boss, 'tax-profiles', true, { derivedKeys: ['storeCount', 'monthSales'] });
    expect(csv.csv).toContain('店铺数');
    expect(csv.csv).toContain('123.45');
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

  it('手动关联的关系类型：独立列保存、修改、读取；未知类型忽略', async () => {
    const a = await svc.create(boss, 'phones', { number: '13500000001', usageType: 'company_kept' });
    const b = await svc.create(boss, 'phones', { number: '13500000002', usageType: 'company_kept' });
    const can = () => true;
    await svc.addManualLink(boss, 'phones', a.id, 'phones', b.id, can, { purpose: '备用', relationKind: '授权' });
    const rel = (await svc.relations(boss, 'phones', a.id, can)).find((r) => r.relation === 'manual')!;
    expect(rel.relationKind).toBe('授权');
    expect(rel.purpose).toBe('备用');
    await svc.updateManualLink(boss, 'phones', a.id, rel.linkId!, { relationKind: '保管', purpose: '备用' });
    expect((await svc.relations(boss, 'phones', a.id, can)).find((r) => r.relation === 'manual')!.relationKind).toBe('保管');
    await svc.updateManualLink(boss, 'phones', a.id, rel.linkId!, { relationKind: '乱写', purpose: '备用' });
    expect((await svc.relations(boss, 'phones', a.id, can)).find((r) => r.relation === 'manual')!.relationKind).toBeNull();
  });

  it('日期条件：未来 N 天内 / 已过期 / 为空（按上海时区算今天）', async () => {
    const t = todayShanghai();
    const day = (n: number) => { const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    stores.quickTabs = [
      { key: 'soon', label: '即将到期', when: { all: [{ field: 'jushuitanExpireAt', op: 'dateWithin', days: 30 }, { field: '$status', op: 'ne', value: 'inactive' }] } },
      { key: 'gone', label: '已过期', when: { field: 'jushuitanExpireAt', op: 'expired' } },
      { key: 'blank', label: '没填', when: { field: 'jushuitanExpireAt', op: 'empty' } },
    ];
    const mk = (name: string, d?: string) => svc.create(boss, 'stores', { platform: 'pdd', name, ...(d ? { jushuitan: 'connected', jushuitanExpireAt: d } : {}) });
    const today = await mk('今天到期D', day(0));
    const in30 = await mk('三十天D', day(30));
    const in31 = await mk('三十一天D', day(31));
    const past = await mk('过期D', day(-1));
    const none = await mk('没填D');
    const ids = async (tab: string) => (await svc.list(boss, 'stores', { tab, pageSize: 200 })).items.map((i) => i.id);
    const soon = await ids('q:soon');
    expect(soon).toEqual(expect.arrayContaining([today.id, in30.id]));
    expect(soon).not.toContain(in31.id);
    expect(soon).not.toContain(past.id);
    expect(await ids('q:gone')).toContain(past.id);
    expect(await ids('q:gone')).not.toContain(today.id);
    expect(await ids('q:blank')).toContain(none.id);
    expect(await ids('q:blank')).not.toContain(today.id);
  });

  it('员工所在部门条件 + 部门动态下拉：含下级、别家部门不认', async () => {
    const mkDept = (c: AuthUser, name: string, parentId: number | null) => ds.manager.save(Department, ds.manager.create(Department, { companyId: c.companyId, name, parentId, sortOrder: 0, status: 'active' }));
    const top = await mkDept(boss, '运营中心', null);
    const sub = await mkDept(boss, '运营一部', top.id);
    const other1 = await mkDept(boss, '财务部', null);
    const foreign = await mkDept(other, '外公司部门', null);
    const mkUser = (account: string, departmentId: number) => ds.manager.save(User, ds.manager.create(User, { companyId: boss.companyId, account, passwordHash: 'x', name: account, departmentId, status: 'active', mustChangePassword: false }));
    const uSub = await mkUser('u-sub', sub.id);
    const uFin = await mkUser('u-fin', other1.id);
    stores.computedFilters = [{ key: 'opDept', label: '运营部门', optionsFrom: 'departments', when: { viaUserDept: 'operatorUserId', dept: '$value', includeChildren: true } }];
    const a = await svc.create(boss, 'stores', { platform: 'pdd', name: '部门店A', operatorUserId: uSub.id });
    const b = await svc.create(boss, 'stores', { platform: 'pdd', name: '部门店B', operatorUserId: uFin.id });
    const c = await svc.create(boss, 'stores', { platform: 'pdd', name: '部门店C' });
    const by = async (dept: number) => (await svc.list(boss, 'stores', { filters: JSON.stringify({ opDept: String(dept) }), pageSize: 200, showHidden: true })).items.map((i) => i.id);
    const underTop = await by(top.id);
    expect(underTop).toContain(a.id);
    expect(underTop).not.toContain(b.id);
    expect(underTop).not.toContain(c.id);
    expect(await by(other1.id)).toEqual(expect.arrayContaining([b.id]));
    await expect(by(foreign.id)).rejects.toThrow();
    // 固定条件写法（不含下级）
    stores.quickTabs = [{ key: 'exact', label: '精确', when: { viaUserDept: 'operatorUserId', dept: top.id } }];
    expect(await (async () => (await svc.list(boss, 'stores', { tab: 'q:exact', pageSize: 200 })).items.map((i) => i.id))()).not.toContain(a.id);
    stores.quickTabs = [{ key: 'bad', label: '坏', when: { viaUserDept: 'name', dept: top.id } }];
    await expect(svc.list(boss, 'stores', { tab: 'q:bad' })).rejects.toThrow();
  });

  it('关系类型按资料类型：这一对有的才能选，没有的拒绝', async () => {
    const can = () => true;
    const phone = await svc.create(boss, 'phones', { number: '13500135001', usageType: 'company_kept' });
    const store = await svc.create(boss, 'stores', { platform: 'pdd', name: '关系店' });
    await expect(svc.addManualLink(boss, 'phones', phone.id, 'stores', store.id, can, { relationKind: '关联营业执照' })).rejects.toThrow(/没有这种关系类型/);
    await svc.addManualLink(boss, 'phones', phone.id, 'stores', store.id, can, { relationKind: '绑定店铺' });
    const rel = (await svc.relations(boss, 'phones', phone.id, can)).find((r) => r.relation === 'manual')!;
    expect(rel.relationKind).toBe('绑定店铺');
  });
});
