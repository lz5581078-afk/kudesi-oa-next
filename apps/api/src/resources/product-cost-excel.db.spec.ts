/** 商品档案成本 Excel 批量导入导出：预检不落库、确认码、新增/更新、锁定与重叠拦截、导出可再导入 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { COST_HEADERS, ProductCostExcelService } from './product-cost-excel.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const row = (over: Record<string, string>) => Object.fromEntries(COST_HEADERS.map((h) => [h, over[h] ?? '']));

d('商品档案成本 Excel（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let xl: ProductCostExcelService;
  let boss: AuthUser;
  let code = '';
  let productId = 0;

  const costs = async () => (await svc.list(boss, 'finance-product-costs', { fieldKey: 'productId', fieldValue: productId, pageSize: 100, showHidden: true } as never)).items;

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    xl = new ProductCostExcelService(ds, svc);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `x${crypto.randomBytes(5).toString('hex')}`, name: '成本导入测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const root = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' })).id;
    const leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: root })).id;
    const p = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '导入苹果', categoryId: leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 100, handlingFee: 50 });
    productId = p.id;
    code = String(p.data.code);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('预检不落库；确认码不对不能导入；确认后新增，再导入同一行是更新', async () => {
    const before = (await costs()).length;
    const rows = [row({ 档案编号: code, 成本类型: '调运成本', 单位成本: '1.2345', 计价单位: '千克', 生效开始: '2026-01-01', 来源类型: '采购单', 来源说明: 'PO-1' })];
    const pre = await xl.preflight(boss, rows);
    expect(pre.errors).toEqual([]);
    expect(pre.created).toBe(1);
    expect((await costs()).length).toBe(before);
    await expect(xl.execute(boss, rows, 'WRONG')).rejects.toThrow(/确认码/);
    const done = await xl.execute(boss, rows, pre.confirm!);
    expect(done.created).toBe(1);
    const got = (await costs()).find((c) => c.data.costType === 'transfer')!;
    expect(got.data.unitCost).toBe(123.45);
    expect(got.data.sourceType).toBe('purchase_order');
    const rows2 = [row({ 档案编号: code, 成本类型: '调运成本', 单位成本: '2', 计价单位: '千克', 生效开始: '2026-01-01' })];
    const pre2 = await xl.preflight(boss, rows2);
    expect(pre2.updated).toBe(1);
    await xl.execute(boss, rows2, pre2.confirm!);
    expect((await costs()).find((c) => c.data.costType === 'transfer')!.data.unitCost).toBe(200);
  });

  it('错误一次列全：缺编码、负数、日期、来源、锁定无原因、重叠；任一错误整份不导入', async () => {
    const rows = [
      row({ 档案编号: 'NOPE', 成本类型: '采购成本', 单位成本: '1', 计价单位: '千克', 生效开始: '2026-02-01' }),
      row({ 档案编号: code, 成本类型: '采购成本', 单位成本: '-1', 计价单位: '', 生效开始: '2026-13-01', 来源类型: '瞎写' }),
      row({ 档案编号: code, 成本类型: '调运成本', 单位成本: '3', 计价单位: '千克', 生效开始: '2026-01-15' }),
      row({ 档案编号: code, 成本类型: '生产成本', 单位成本: '3', 计价单位: '千克', 生效开始: '2026-03-01', 手工锁定: '是' }),
    ];
    const pre = await xl.preflight(boss, rows);
    const msgs = pre.errors.map((e) => `${e.row}:${e.field}`);
    expect(msgs).toEqual(expect.arrayContaining(['2:档案编号', '3:单位成本', '3:计价单位', '3:生效开始', '3:来源类型', '5:锁定原因']));
    expect(pre.errors.some((e) => e.row === 4 && /重叠/.test(e.message))).toBe(true);
    expect(pre.confirm).toBeNull();
  });

  it('手工锁定的记录不能被导入覆盖；导出的内容可以原样再导入（无变化也不报错）', async () => {
    const cost = (await costs()).find((c) => c.data.costType === 'transfer')!;
    await svc.update(boss, 'finance-product-costs', cost.id, { manualOverride: true, manualLockReason: '合同价' });
    const pre = await xl.preflight(boss, [row({ 档案编号: code, 成本类型: '调运成本', 单位成本: '9', 计价单位: '千克', 生效开始: '2026-01-01' })]);
    expect(pre.errors[0].message).toMatch(/手工锁定/);
    await svc.update(boss, 'finance-product-costs', cost.id, { manualOverride: false });
    const out = await xl.export(boss);
    expect(out.headers).toEqual([...COST_HEADERS]);
    expect(out.rows.length).toBeGreaterThan(0);
    const back = out.rows.map((r) => Object.fromEntries(COST_HEADERS.map((h, i) => [h, r[i]])));
    const pre2 = await xl.preflight(boss, back);
    expect(pre2.errors).toEqual([]);
    expect((await xl.template(boss)).rows.length).toBeGreaterThan(0);
  });
});
