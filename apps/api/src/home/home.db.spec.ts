/** 首页聚合的真实数据库测试（按岗位类型/权限过滤、公司隔离、成本不外泄）。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_h npx jest home.db --runInBand */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { HOME_WORKSPACE_TYPES, HOME_WORKSPACES, NAV_SECTIONS } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FlowRun, Position, User, WorkItem } from '../entities';
import { WORKSPACE_TYPES } from '../org/org-admin.service';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const day = new Date().toISOString().slice(0, 10);

describe('首页配置', () => {
  it('岗位类型与后端岗位类型一致，常用入口都指向导航里真实存在的页面', () => {
    expect([...HOME_WORKSPACE_TYPES].sort()).toEqual([...WORKSPACE_TYPES].sort());
    const pages = new Set(NAV_SECTIONS.flatMap((s) => s.pages.map((p) => `${s.id}.${p.id}`)));
    for (const t of HOME_WORKSPACE_TYPES) for (const link of HOME_WORKSPACES[t].links) expect(pages.has(link)).toBe(true);
  });
  it('首页接口必须声明为“只要登录”（默认拒绝体系里不能漏写）', () => {
    expect(Reflect.getMetadata('auth:authenticated-only', HomeController.prototype.get)).toBe(true);
  });
});

d('首页聚合（真实数据库）', () => {
  let ds: DataSource, home: HomeService, docs: FinanceDocumentsService;
  const u: Record<string, AuthUser> = {};
  let other: AuthUser;
  const ids: Record<string, number> = {};

  const mkCompany = async (prefix: string) => {
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `${prefix}${crypto.randomBytes(5).toString('hex')}`, name: '首页测试', status: 'active' }));
    const admin = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    return { c, admin, au: { id: admin.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser };
  };
  const mkUser = async (companyId: number, key: string, type: string | null, allow: string[], extraType?: string) => {
    const pos = type ? await ds.manager.save(Position, ds.manager.create(Position, { companyId, name: `${key}岗`, workspaceType: type as never, sortOrder: 0, level: 'staff', supervisorPositionId: null, description: null, status: 'active', departmentId: null })) : null;
    const extra = extraType ? await ds.manager.save(Position, ds.manager.create(Position, { companyId, name: `${key}兼岗`, workspaceType: extraType as never, sortOrder: 0, level: 'staff', supervisorPositionId: null, description: null, status: 'active', departmentId: null })) : null;
    const row = await ds.manager.save(User, ds.manager.create(User, { companyId, account: key, passwordHash: 'x', name: `${key}员工`, status: 'active', mustChangePassword: false, positionId: pos?.id ?? null, extraPositionIds: extra ? [extra.id] : null }));
    return { id: row.id, companyId, name: row.name, permissions: { isCompanyAdmin: false, allow, deny: [] } } as AuthUser;
  };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const services = buildServices(ds);
    docs = new FinanceDocumentsService(ds);
    home = new HomeService(ds, new FlowService(ds, services.resources, docs), services.resources, docs);
    home.cacheMs = 0;
    const a = await mkCompany('ha');
    const b = await mkCompany('hb');
    u.boss = a.au;
    other = b.au;

    const flowPerms = ['workbench.todos.view', 'workbench.tasks.view', 'flow.apply.view'];
    u.ops = await mkUser(a.c.id, 'ops', 'operations', [...flowPerms, 'finance.pricing-debug.view']);
    u.fin = await mkUser(a.c.id, 'fin', 'finance', [...flowPerms, 'finance.overview.view', 'finance.inventory.view', 'finance.cash-bank.view']);
    u.finCost = await mkUser(a.c.id, 'fincost', 'finance', [...flowPerms, 'finance.overview.view', 'finance.inventory.view', 'product.cost.view']);
    u.wh = await mkUser(a.c.id, 'wh', 'warehouse', ['finance.inventory.view']);
    u.multi = await mkUser(a.c.id, 'multi', 'operations', [...flowPerms, 'finance.inventory.view'], 'warehouse');
    u.blank = await mkUser(a.c.id, 'blank', null, []);
    u.general = await mkUser(a.c.id, 'gen', 'general', ['resource.stores.view', 'resource.licenses.view', 'resource.overview.view']);
    u.supervisor = await mkUser(a.c.id, 'sup', 'support', ['flow.overview.view', ...flowPerms]);

    const svc = services.resources;
    const cat = (await svc.create(u.boss, 'finance-categories', { archiveType: 'raw', name: '首页类', code: 'HP' })).id;
    ids.pear = (await svc.create(u.boss, 'finance-products', { archiveType: 'raw', name: '首页梨', categoryId: cat, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 300, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' })).id;
    ids.cust = (await svc.create(u.boss, 'finance-customers', { name: '首页客户' })).id;
    ids.supp = (await svc.create(u.boss, 'finance-suppliers', { name: '首页果园' })).id;
    ids.wh = (await svc.create(u.boss, 'finance-warehouses', { name: '首页仓' })).id;
    // 入库 5 个梨，卖光 → 缺货；本月收入 4500，成本 1500
    await docs.post(u.boss, (await docs.createDraft(u.boss, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, lines: [{ productId: ids.pear, qty: 5, unitPriceCents: 300 }] })).id);
    await docs.post(u.boss, (await docs.createDraft(u.boss, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, lines: [{ productId: ids.pear, qty: 5, unitPriceCents: 900 }] })).id);
    // 一家店铺异常 + 一个快到期的营业执照
    ids.store = (await svc.create(u.boss, 'stores', { name: '首页异常店', platform: 'pdd' })).id;
    await ds.query("UPDATE resource_records SET status = 'abnormal' WHERE id = ?", [ids.store]);
    // 办理中的流程：运营发起，财务有一条逾期待办
    const past = new Date(Date.now() - 3 * 86400_000);
    const run = await ds.manager.save(FlowRun, ds.manager.create(FlowRun, { companyId: a.c.id, definitionId: 0, templateKey: 'license-borrow', title: '借执照-首页', status: 'running', requesterId: u.ops.id, currentStepKey: 'approve', payload: {}, stepsSnapshot: [], escalateUserIds: [], dueAt: past }));
    await ds.manager.save(WorkItem, ds.manager.create(WorkItem, { companyId: a.c.id, kind: 'flow', runId: run.id, stepId: null, assigneeId: u.fin.id, createdBy: null, title: '借执照-首页', status: 'open', dueAt: past }));
    await ds.manager.save(WorkItem, ds.manager.create(WorkItem, { companyId: a.c.id, kind: 'task', assigneeId: u.fin.id, createdBy: u.supervisor.id, title: '核对库存', status: 'open', dueAt: null }));
    // 另一家公司的数据：不能出现在 A 公司首页
    const sb = buildServices(ds).resources;
    ids.bStore = (await sb.create(other, 'stores', { name: 'B公司异常店', platform: 'pdd' })).id;
    await ds.query("UPDATE resource_records SET status = 'abnormal' WHERE id = ?", [ids.bStore]);
    await ds.manager.save(FlowRun, ds.manager.create(FlowRun, { companyId: b.c.id, definitionId: 0, templateKey: 'license-borrow', title: 'B公司逾期流程', status: 'running', requesterId: other.id, currentStepKey: 'approve', payload: {}, stepsSnapshot: [], escalateUserIds: [], dueAt: past }));
  });
  afterAll(async () => { await ds?.destroy(); });

  it('管理员按老板处理：财务、店铺排行、逾期流程、各人逾期、资料预警都有；没有成本限制', async () => {
    const h = await home.get(u.boss);
    expect(h.workspace).toMatchObject({ type: 'boss', title: '老板工作台' });
    expect(h.widgets).toEqual(expect.arrayContaining(['finance', 'stores', 'flowAlerts', 'people', 'resourceAlerts', 'todos']));
    expect(h.finance).toMatchObject({ revenueCents: 4500, netProfitCents: 3000 });
    expect(h.flowAlerts?.overdue).toBe(1);
    expect(h.flowAlerts?.rows[0].title).toBe('借执照-首页');
    expect(h.people?.rows).toEqual([{ userId: u.fin.id, name: 'fin员工', pending: 2, overdue: 1 }]);
    expect(h.resourceAlerts?.abnormal).toEqual([{ type: 'stores', label: expect.any(String), abnormal: 1 }]);
  });

  it('公司隔离：B 公司的店铺异常和逾期流程不会出现在 A 公司的首页，反过来也一样', async () => {
    const a = JSON.stringify(await home.get(u.boss));
    expect(a).not.toContain('B公司');
    const b = await home.get(other);
    expect(JSON.stringify(b)).not.toContain('首页异常店');
    expect(JSON.stringify(b)).not.toContain('借执照-首页');
    expect(b.flowAlerts?.overdue).toBe(1);
    expect(b.finance?.revenueCents).toBe(0);
    expect(b.resourceAlerts?.abnormalTotal).toBe(1);
  });

  it('运营：只有待办/我发起的/任务/发起申请，没有财务、库存、监督；我发起的能看到自己的流程', async () => {
    const h = await home.get(u.ops);
    expect(h.workspace.type).toBe('operations');
    expect(h.widgets).toEqual(['apply', 'todos', 'started', 'tasks']);
    expect(h.started).toMatchObject({ running: 1 });
    expect(h.started?.rows[0]).toMatchObject({ title: '借执照-首页', overdue: true });
    for (const k of ['finance', 'stores', 'stock', 'flowAlerts', 'people', 'resourceAlerts'] as const) expect(h[k]).toBeUndefined();
  });

  it('财务：没有成本查看权限时服务端不给利润；有成本权限才给；任何情况都不带成本明细', async () => {
    const noCost = await home.get(u.fin);
    expect(noCost.finance).toMatchObject({ revenueCents: 4500, netProfitCents: null });
    expect(noCost.finance?.bankCents).not.toBeUndefined();
    expect(noCost.finance?.trend.every((t) => t.profitCents === null)).toBe(true);
    expect(noCost.stores?.rows.every((s) => s.profitCents === null)).toBe(true);
    const withCost = await home.get(u.finCost);
    expect(withCost.finance?.netProfitCents).toBe(3000);
    expect(withCost.finance?.bankCents).toBeNull(); // 没有现金银行权限就不给银行余额
    for (const dto of [noCost, withCost]) expect(JSON.stringify(dto)).not.toMatch(/cogs|avgCost|amountCents|grossProfit/);
    // 库存缺货：梨卖光了
    expect(noCost.stock?.outCount).toBe(1);
    expect(noCost.stock?.rows[0]).toMatchObject({ productName: '首页梨', warehouseName: '首页仓' });
  });

  it('财务的待办：自己的待办数、逾期数，以及我指派的任务；别人的流程不算', async () => {
    const h = await home.get(u.fin);
    expect(h.todos).toMatchObject({ pending: 2, overdue: 1 });
    expect(h.todos?.rows.map((r) => r.title)).toContain('借执照-首页');
    expect(h.started?.running).toBe(0);
    const sup = await home.get(u.supervisor);
    expect(sup.tasks).toEqual({ open: 1, overdue: 0 });
    expect(sup.flowAlerts?.overdue).toBe(1);
    expect(sup.workspace.type).toBe('support');
  });

  it('仓库：只有库存缺货和基础卡片；没有库存权限的人库存卡片不出现', async () => {
    const h = await home.get(u.wh);
    expect(h.workspace.type).toBe('warehouse');
    expect(h.widgets).toEqual(['stock', 'todos', 'started']);
    expect(h.stock?.outCount).toBe(1);
    expect(h.stock?.rows[0]).not.toHaveProperty('amountCents');
  });

  it('兼任岗位：卡片取并集，主岗位决定标题', async () => {
    const h = await home.get(u.multi);
    expect(h.workspace).toMatchObject({ type: 'operations', types: ['operations', 'warehouse'] });
    expect(h.widgets).toEqual(expect.arrayContaining(['apply', 'todos', 'stock']));
  });

  it('综合：资料预警只统计有查看权限的资料类型；没有任何资料权限则不出现该卡片', async () => {
    const h = await home.get(u.general);
    expect(h.widgets).toContain('resourceAlerts');
    expect(h.resourceAlerts?.abnormalTotal).toBe(1);
    // 去掉店铺权限后，店铺异常不再被统计
    const onlyLicenses: AuthUser = { ...u.general, permissions: { isCompanyAdmin: false, allow: ['resource.licenses.view'], deny: [] } };
    expect((await home.get(onlyLicenses)).resourceAlerts?.abnormalTotal).toBe(0);
    const denied: AuthUser = { ...u.general, permissions: { isCompanyAdmin: false, allow: ['resource.stores.view'], deny: ['resource.stores.view'] } };
    expect((await home.get(denied)).widgets).not.toContain('resourceAlerts');
  });

  it('空白岗位/没有岗位的人：只有最基础的卡片，空数据正常返回', async () => {
    const h = await home.get(u.blank);
    expect(h.workspace).toMatchObject({ type: 'blank', positionName: null });
    expect(h.widgets).toEqual(['todos', 'started']);
    expect(h.todos).toMatchObject({ pending: 0, rows: [] });
  });

  it('权限被收回后马上生效（缓存键包含权限）', async () => {
    home.cacheMs = 60_000;
    try {
      const before = await home.get(u.fin);
      expect(before.widgets).toContain('finance');
      const revoked: AuthUser = { ...u.fin, permissions: { ...u.fin.permissions, allow: u.fin.permissions.allow.filter((p) => p !== 'finance.overview.view') } };
      const after = await home.get(revoked);
      expect(after.widgets).not.toContain('finance');
      expect(after.finance).toBeUndefined();
    } finally { home.cacheMs = 0; }
  });
});
