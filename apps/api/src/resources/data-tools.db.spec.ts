/** 数据板块工具（成本历史、包装方案、API 密钥、主数据重置）的真实数据库测试。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { PROVINCES } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { normalizeExpressRows } from '../integrations/ocr.service';
import { buildServices } from '../test-support';
import { CostService } from './cost.service';
import { DataToolsService } from './data-tools.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('数据板块工具（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let tools: DataToolsService;
  let cost: CostService;
  let boss: AuthUser;
  let staff: AuthUser;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    cost = new CostService(ds);
    tools = new DataToolsService(ds, cost);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `t${crypto.randomBytes(5).toString('hex')}`, name: '数据工具', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    staff = { id: u.id, companyId: c.id, name: '员工', permissions: { isCompanyAdmin: false, allow: ['finance.api-keys.view', 'finance.master-reset.view'], deny: [] } };

    ids.root = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' })).id;
    ids.leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: ids.root })).id;
    ids.pkgRoot = (await svc.create(boss, 'finance-categories', { archiveType: 'package', name: '包装', code: 'BZ' })).id;
    ids.pkgLeaf = (await svc.create(boss, 'finance-categories', { archiveType: 'package', name: '纸箱', code: 'ZX', parentId: ids.pkgRoot })).id;
    ids.apple = (await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '苹果', categoryId: ids.leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' })).id;
    ids.box = (await svc.create(boss, 'finance-products', { archiveType: 'package', name: '5斤纸箱', categoryId: ids.pkgLeaf, specQty: 1, specUnit: 'PCS', capacities: '5斤', weightManual: true, weightG: 200, purchasePrice: 300, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' })).id;
    ids.bc = (await svc.create(boss, 'finance-base-codes', { productId: ids.apple, code: 'APPLE-A', codeChangeReason: '测试' })).id;
    await svc.changeStatus(boss, 'finance-base-codes', ids.bc, 'verified');
    const plat = await svc.create(boss, 'finance-platforms', { code: 'TB', name: '淘宝' });
    const scen = await svc.create(boss, 'finance-scenarios', { code: 'supply_chain', name: '供应链', segment: 'GYL' });
    ids.scen = scen.id;
    ids.bundle = (await svc.create(boss, 'finance-bundles', { platformId: plat.id, scenarioId: scen.id })).id;
    await svc.create(boss, 'finance-bundle-lines', { bundleId: ids.bundle, role: 'main', baseCodeId: ids.bc, qty: 1 });
    await svc.create(boss, 'finance-margins', { profitPercent: 20, reason: '默认' });
  });
  afterAll(async () => { await ds?.destroy(); });

  it('成本历史：验证后登记快照，没变化不重复记，成本变了记新版本并列出变化', async () => {
    const first = await tools.registerCost(boss, ids.bundle, '首次');
    expect(first).toEqual({ recorded: 1, unchanged: 0 });
    expect(await tools.registerCost(boss, ids.bundle, '再来')).toEqual({ recorded: 0, unchanged: 1 });
    await svc.update(boss, 'finance-products', ids.apple, { purchasePrice: 1500 });
    await svc.changeStatus(boss, 'finance-base-codes', ids.bc, 'verified');
    await tools.registerCost(boss, ids.bundle, '苹果涨价');
    const h = await tools.costHistory(boss, { bundleId: ids.bundle, page: 1, pageSize: 10 });
    expect(h.total).toBe(2);
    expect(h.rows[0].revision).toBe(2);
    expect(h.rows[0].changes.find((x: { field: string }) => x.field === 'preShipCostCents')).toMatchObject({ before: 1000, after: 1500 });
    expect(h.rows[1].changes).toEqual([]);
  });

  it('包装方案：明细只能选包装档案；匹配规则按优先级、重量、编码命中，同优先级冲突要提示', async () => {
    const scheme = await svc.create(boss, 'finance-packaging-schemes', { schemeCode: 'pk-a', schemeName: '通用发货箱', usageScene: 'dispatch' });
    expect(scheme.data.schemeCode).toBe('PK-A');
    await expect(svc.create(boss, 'finance-packaging-lines', { schemeId: scheme.id, componentId: ids.apple, role: 'package', qty: 1, costTreatment: 'include' })).rejects.toThrow(/不是产品包装/);
    const line = await svc.create(boss, 'finance-packaging-lines', { schemeId: scheme.id, componentId: ids.box, role: 'package', qty: 1, costTreatment: 'include' });
    expect(line.data.costBucket).toBe('shipping_package');
    await expect(svc.create(boss, 'finance-packaging-rules', { schemeId: scheme.id, targetType: 'general', minWeightKg: 5, maxWeightKg: 1, priority: 10 })).rejects.toThrow(/不能小于下限/);
    await svc.create(boss, 'finance-packaging-rules', { schemeId: scheme.id, targetType: 'general', minWeightKg: 0, maxWeightKg: 3, priority: 100 });
    const m1 = await tools.packagingMatch(boss, { usageScene: 'dispatch', targetType: 'bundle', weightKg: 2 });
    expect(m1.selected?.scheme.code).toBe('PK-A');
    expect(m1.selected?.lines[0].componentName).toBe('5斤纸箱');
    expect(m1.ambiguous).toBe(false);
    const none = await tools.packagingMatch(boss, { usageScene: 'dispatch', targetType: 'bundle', weightKg: 9 });
    expect(none.selected).toBeNull();
    expect(none.issues[0].message).toMatch(/没有匹配/);
    const s2 = await svc.create(boss, 'finance-packaging-schemes', { schemeCode: 'PK-B', schemeName: '另一个箱', usageScene: 'dispatch' });
    await svc.create(boss, 'finance-packaging-rules', { schemeId: s2.id, targetType: 'bundle', targetCode: 'zh-x', discreteWeights: '1, 2', priority: 100 });
    const m2 = await tools.packagingMatch(boss, { usageScene: 'dispatch', targetType: 'bundle', targetCode: 'ZH-X', weightKg: 2 });
    expect(m2.matches).toHaveLength(2);
    expect(m2.ambiguous).toBe(true);
    // 失效日期已过的方案不参与
    await svc.update(boss, 'finance-packaging-schemes', s2.id, { effectiveTo: '2020-01-01' });
    expect((await tools.packagingMatch(boss, { usageScene: 'dispatch', targetType: 'bundle', targetCode: 'ZH-X', weightKg: 2 })).matches).toHaveLength(1);
  });

  it('API 密钥：只有管理员能管；明文只返回一次；撤销后不能用', async () => {
    await expect(tools.createKey(staff, '外部系统')).rejects.toThrow(/管理员/);
    const k = await tools.createKey(boss, '聚水潭对账');
    expect(k.key).toMatch(/^kdoa1\./);
    const list = await tools.listKeys(boss);
    expect(JSON.stringify(list)).not.toContain(k.key);
    await expect(tools.authenticateKey(k.key)).resolves.toBe(boss.companyId);
    await expect(tools.authenticateKey(`${k.key}x`)).rejects.toThrow();
    await expect(tools.authenticateKey(undefined)).rejects.toThrow();
    const feed = await tools.externalFeed(boss.companyId);
    expect(feed.rows.length).toBeGreaterThanOrEqual(0);
    await tools.revokeKey(boss, k.id);
    await expect(tools.authenticateKey(k.key)).rejects.toThrow(/无效或已撤销/);
    await expect(tools.revokeKey(boss, k.id)).rejects.toThrow(/不存在或已撤销/);
  });

  it('主数据重置：确认文本、管理员限制；先留快照再清空；可从快照恢复（含原 id）', async () => {
    const pre = await tools.resetPreview(boss, true);
    expect(pre.confirmation).toBe(`RESET-COMPANY-${boss.companyId}`);
    expect(pre.tables.find((t) => t.type === 'finance-products')?.count).toBe(2);
    await expect(tools.resetExecute(staff, { confirm: pre.confirmation })).rejects.toThrow(/管理员/);
    await expect(tools.resetExecute(boss, { confirm: 'nope' })).rejects.toThrow(/确认文本不正确/);
    const done = await tools.resetExecute(boss, { confirm: pre.confirmation, includePlatforms: true });
    expect(done.totalDeleted).toBeGreaterThan(5);
    expect(await ds.query("SELECT COUNT(*) AS n FROM resource_records WHERE company_id = ? AND type IN ('finance-products','finance-bundles','finance-categories')", [boss.companyId])).toEqual([{ n: '0' }]);
    expect((await tools.costHistory(boss, { page: 1, pageSize: 10 })).total).toBe(0);
    const snaps = await tools.snapshots(boss);
    expect(snaps[0].rowCount).toBeGreaterThan(5);
    await expect(tools.restore(boss, snaps[0].id, 'x')).rejects.toThrow(/确认文本不正确/);
    const back = await tools.restore(boss, snaps[0].id, snaps[0].confirmation);
    expect(back.restored).toBe(snaps[0].rowCount);
    const apple = await svc.get(boss, 'finance-products', ids.apple);
    expect(apple.title).toBe('苹果');
    expect(apple.data.totalCost).toBe(1500);
    // 有财务单据明细用到商品时不允许重置
    await ds.query('INSERT INTO finance_documents (company_id, doc_no, doc_type, status, doc_date, amount_cents, offset_cents, created_by) VALUES (?, ?, ?, ?, ?, 0, 0, ?)', [boss.companyId, 'XS-T1', 'sale', 'draft', '2026-01-01', boss.id]);
    const [{ id }] = await ds.query('SELECT id FROM finance_documents WHERE company_id = ? AND doc_no = ?', [boss.companyId, 'XS-T1']);
    await ds.query('INSERT INTO finance_document_lines (company_id, document_id, line_no, product_id, qty, unit_price_cents) VALUES (?, ?, 1, ?, 1, 100)', [boss.companyId, id, ids.apple]);
    await expect(tools.resetExecute(boss, { confirm: pre.confirmation })).rejects.toThrow(/用到了商品档案/);
  });

  it('快递价格表识别结果整理：金额转分、省份规范、缺价格的行带提醒', () => {
    const out = normalizeExpressRows({ carrier: ' 中通 ', branch: '广州', validFrom: '2026年3月1日', rows: [
      { province: '广东省', weightMin: 0, weightMax: 1, firstWeight: 1, firstPrice: '3.50', extraPrice: 1.2 },
      { province: '全国', weightMin: 1, weightMax: 3, fixedPrice: 8 },
      { province: '火星', weightMin: 0, weightMax: 1 },
    ] }, PROVINCES);
    expect(out.rows[0]).toMatchObject({ carrier: '中通', province: '广东', firstPrice: 350, extraPrice: 120, validFrom: '2026-03-01', warnings: [] });
    expect(out.rows[1]).toMatchObject({ province: 'ALL', fixedPrice: 800 });
    expect(out.rows[2].warnings.join()).toMatch(/不在省份清单|没有固定价/);
    expect(normalizeExpressRows({ rows: [] }, PROVINCES).warnings.join()).toMatch(/快递公司/);
  });
});
