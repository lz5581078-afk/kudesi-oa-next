/** 工作台（真实数据库）。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_u7 npx jest workspace */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { todayInChina } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Department, Position, ResourceRecord, User, WorkItem } from '../entities';
import { buildServices } from '../test-support';
import { TaskService } from '../flow/task.service';
import { WorkspaceModuleRegistry } from './module-registry';
import { WorkspaceService } from './workspace.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('工作台（真实数据库）', () => {
  let ds: DataSource, ws: WorkspaceService, tasks: TaskService, registry: WorkspaceModuleRegistry;
  let cid: number, otherCid: number, boss: AuthUser, worker: AuthUser, staff: AuthUser, stranger: AuthUser;
  let finPos: number, opsPos: number;
  const mk = async (companyId: number, account: string, name: string, extra: Partial<User> = {}) => (await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra }))).id;
  const au = (id: number, companyId: number, name: string, allow: string[], admin = false): AuthUser => ({ id, companyId, name, permissions: { isCompanyAdmin: admin, allow, deny: [] } });
  const rec = (companyId: number, type: string, title: string, data: Record<string, unknown>, status = 'normal') => ds.manager.save(ResourceRecord, ds.manager.create(ResourceRecord, { companyId, type, title, status, data } as never));

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test_u7' }), migrationsRun: true } as never);
    await ds.initialize();
    const svc = buildServices(ds);
    tasks = new TaskService(ds);
    registry = new WorkspaceModuleRegistry();
    ws = new WorkspaceService(ds, svc.resources, registry);
    const mkCompany = (n: string) => ds.manager.save(Company, ds.manager.create(Company, { code: `w${crypto.randomBytes(5).toString('hex')}`, name: n, status: 'active' }));
    const c = await mkCompany('工作台测试'), c2 = await mkCompany('别家');
    cid = c.id; otherCid = c2.id;
    const root = await ds.manager.save(Department, ds.manager.create(Department, { companyId: cid, name: '总部', sortOrder: 1 } as never));
    const dept = await ds.manager.save(Department, ds.manager.create(Department, { companyId: cid, name: '财务部', parentId: root.id, sortOrder: 2 } as never));
    finPos = (await ds.manager.save(Position, ds.manager.create(Position, { companyId: cid, departmentId: dept.id, name: '会计', workspaceType: 'finance', level: 'staff' } as never))).id;
    opsPos = (await ds.manager.save(Position, ds.manager.create(Position, { companyId: cid, departmentId: root.id, name: '运营', workspaceType: 'operations', level: 'staff' } as never))).id;
    await ds.manager.save(Position, ds.manager.create(Position, { companyId: otherCid, departmentId: null, name: '别家岗位', workspaceType: 'finance', level: 'staff' } as never));
    boss = au(await mk(cid, 'boss', '老板'), cid, '老板', [], true);
    worker = au(await mk(cid, 'wk', '员工', { positionId: finPos }), cid, '员工', ['workbench.desk.view', 'finance.drafts.view']);
    staff = au(await mk(cid, 'st', '主管', { positionId: opsPos }), cid, '主管', ['tasks.assign']);
    stranger = au(await mk(otherCid, 'str', '外人'), otherCid, '外人', ['workbench.desk.view']);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('岗位目录：管理员浏览全部在用岗位且带部门路径；普通员工只有自己在岗的岗位；不串公司', async () => {
    const all = await ws.catalog(boss);
    expect(all.canBrowse).toBe(true);
    expect(all.positions.map((p) => p.name).sort()).toEqual(['会计', '运营']);
    expect(all.positions.find((p) => p.name === '会计')).toMatchObject({ departmentPath: '总部 / 财务部', workspaceType: 'finance' });
    const mine = await ws.catalog(worker);
    expect(mine.canBrowse).toBe(false);
    expect(mine.positions.map((p) => p.name)).toEqual(['会计']);
    expect(mine.defaultPositionId).toBe(finPos);
    expect((await ws.catalog(stranger)).positions.map((p) => p.name)).toEqual([]);
  });

  it('岗位工作台：看不到的岗位不存在；财务岗位有草稿汇总；没有售后模块时标暂无', async () => {
    await expect(ws.desk(worker, opsPos)).rejects.toThrow(/无权/);
    await expect(ws.desk(stranger, finPos)).rejects.toThrow(/无权/);
    const desk = await ws.desk(worker, finPos);
    expect(desk.title).toBe('会计工作台');
    expect(desk.cards.map((c) => c.key)).toEqual(expect.arrayContaining(['drafts', 'issued']));
    const ops = await ws.desk(boss, opsPos);
    expect(ops.cards.find((c) => c.module === 'live')).toMatchObject({ value: null, hint: '暂无该模块' });
    registry.register({ key: 'live', deskCards: async () => [{ key: 'live-x', label: '今日直播场次', value: 3 }] });
    expect((await ws.desk(boss, opsPos)).cards.find((c) => c.key === 'live-x')?.value).toBe(3);
  });

  it('个人任务四分类：新任务→进行中→提交复核→待复核→退回→通过；自己建的任务不能提交复核', async () => {
    const t = await tasks.create(staff, { title: '盘点库存', assigneeId: worker.id });
    let l = await ws.tasks(worker, { view: 'new' });
    expect(l.rows.map((r) => r.title)).toContain('盘点库存');
    expect(l.rows[0].can).toMatchObject({ start: true, complete: true, submit: true, review: false });
    await expect(ws.start(staff, t.id)).rejects.toThrow(/负责人/);
    await ws.start(worker, t.id);
    l = await ws.tasks(worker, { view: 'processing' });
    expect(l.rows.find((r) => r.id === t.id)?.stage).toBe('processing');
    expect((await ws.tasks(worker, { view: 'new' })).rows.find((r) => r.id === t.id)).toBeUndefined();
    await ws.submit(worker, t.id, '盘完了');
    await expect(tasks.complete(worker, t.id)).rejects.toThrow(/复核/);
    const rv = await ws.tasks(staff, { view: 'review' });
    expect(rv.rows[0]).toMatchObject({ id: t.id, stage: 'submitted', doneNote: '盘完了' });
    expect(rv.rows[0].can.review).toBe(true);
    expect((await ws.tasks(worker, { view: 'processing' })).rows.find((r) => r.id === t.id)?.stage).toBe('submitted');
    await expect(ws.review(worker, t.id, true)).rejects.toThrow(/指派人/);
    await expect(ws.review(staff, t.id, false)).rejects.toThrow(/原因/);
    await ws.review(staff, t.id, false, '少盘了二楼');
    expect((await ws.tasks(staff, { view: 'review' })).total).toBe(0);
    expect((await ws.tasks(worker, { view: 'processing' })).rows.find((r) => r.id === t.id)).toMatchObject({ stage: 'processing', reviewNote: '少盘了二楼' });
    await ws.submit(worker, t.id);
    await ws.review(staff, t.id, true, '好');
    const done = await ws.tasks(worker, { view: 'done' });
    expect(done.rows.find((r) => r.id === t.id)?.status).toBe('done');
    expect(done.counts.done).toBeGreaterThan(0);
    const mine = await tasks.create(worker, { title: '自己的事' });
    await expect(ws.submit(worker, mine.id)).rejects.toThrow(/不需要复核/);
    await expect(ws.start(stranger, mine.id)).rejects.toThrow(/不存在/);
  });

  it('个人任务计数：已超时只算我负责且未结束的', async () => {
    const t = await tasks.create(staff, { title: '过期的', assigneeId: worker.id });
    await ds.manager.update(WorkItem, { id: t.id }, { dueAt: new Date(Date.now() - 3_600_000) } as never);
    const l = await ws.tasks(worker, { view: 'new' });
    expect(l.counts.overdue).toBeGreaterThanOrEqual(1);
    expect(l.rows.find((r) => r.id === t.id)?.overdue).toBe(true);
    expect((await ws.tasks(staff, { view: 'new' })).rows.find((r) => r.id === t.id)).toBeUndefined();
  });

  it('老板总控台：待办超时、人员排行、店铺经营；没有成本权限的人拿不到利润；监督模块接入后出现异常', async () => {
    const store = await rec(cid, 'stores', '一号店', { platform: 'TB' }, 'abnormal');
    await rec(cid, 'stores', '二号店', { platform: 'DY' });
    const today = todayInChina();
    await rec(cid, 'store-daily-metrics', '一号店今日', { day: today, storeId: store.id, sales: 100000, refund: 10000, adCost: 20000, platformFee: 5000, purchaseCost: 30000, otherCost: 0 });
    await rec(otherCid, 'store-daily-metrics', '别家', { day: today, storeId: 99999, sales: 999999 });
    const b = await ws.boss(boss);
    expect(b.attention.find((c) => c.key === 'abnormal-stores')).toMatchObject({ value: 1 });
    expect(b.attention.find((c) => c.key === 'overdue-items')!.value).toBeGreaterThanOrEqual(1);
    expect(b.today).toMatchObject({ salesCents: 100000, profitCents: 35000, hasData: true });
    expect(b.stores[0]).toMatchObject({ name: '一号店', salesCents: 100000, profitCents: 35000 });
    expect(b.people.find((p) => p.name === '员工')!.overdue).toBeGreaterThanOrEqual(1);
    expect(b.exceptions.available).toBe(false);
    expect(b.attention.find((c) => c.key === 'exceptions')).toMatchObject({ value: null, hint: '暂无该模块' });
    expect(b.modules).toMatchObject({ supervision: false, 'after-sales': false });
    const noCost = await ws.boss(au(boss.id, cid, '老板', ['workbench.boss.view']));
    expect(noCost.today.profitCents).toBeNull();
    expect(noCost.stores[0].profitCents).toBeNull();
    expect(noCost.today.salesCents).toBe(100000);
    registry.register({ key: 'supervision', exceptions: async () => ({ total: 1, rows: [{ id: 1, title: '漏发', severity: 'urgent', ownerName: '员工', storeName: '一号店', escalatedLevel: 1 }], byUser: { [worker.id]: 2 } }) });
    const b2 = await ws.boss(boss);
    expect(b2.exceptions).toMatchObject({ available: true, total: 1 });
    expect(b2.people.find((p) => p.name === '员工')!.exceptions).toBe(2);
    expect(b2.modules.supervision).toBe(true);
    const other = await ws.boss(au(stranger.id, otherCid, '外人', []));
    expect(other.today.salesCents).toBe(999999); // 只汇总自己公司的数据
    expect(other.stores.map((x) => x.name)).not.toContain('一号店');
    expect(other.attention.find((c) => c.key === 'abnormal-stores')!.value).toBe(0);
  });

  it('每日经营：按日期汇总各店铺，列出这天没数据的在用店铺；没有成本权限不返回利润；不含别家和停用店铺', async () => {
    const a = await rec(cid, 'stores', '日一店', { platform: 'TB' });
    const b = await rec(cid, 'stores', '日二店', { platform: 'DY' });
    await rec(cid, 'stores', '已注销店', {}, 'cancelled');
    await rec(cid, 'store-daily-metrics', 'a', { day: '2026-03-01', storeId: a.id, sales: 20000, refund: 0, adCost: 5000, platformFee: 0, purchaseCost: 5000, otherCost: 0 });
    const r = await ws.daily(boss, '2026-03-01');
    expect(r.stores).toHaveLength(1);
    expect(r.stores[0]).toMatchObject({ name: '日一店', salesCents: 20000, adCostCents: 5000, profitCents: 10000, marginPpm: 50000000 });
    expect(r.totals).toMatchObject({ salesCents: 20000, profitCents: 10000, marginPpm: 50000000 });
    expect(r.missing.map((m) => m.name)).toContain('日二店');
    expect(r.missing.map((m) => m.name)).not.toContain('已注销店');
    expect(r.missing.map((m) => m.storeId)).toContain(b.id);
    const nc = await ws.daily(au(boss.id, cid, '老板', []), '2026-03-01');
    expect(nc.stores[0].profitCents).toBeNull();
    expect(nc.totals.profitCents).toBeNull();
    expect(nc.stores[0].salesCents).toBe(20000);
    expect((await ws.daily(boss, 'garbage')).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
