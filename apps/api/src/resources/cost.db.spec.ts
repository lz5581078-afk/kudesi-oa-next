/** 成本表 / 定价调试表的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_a npx jest cost.db */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FinanceCostSnapshot, ResourceChangeLog, User } from '../entities';
import { buildServices } from '../test-support';
import { CostMaintainService } from './cost-maintain.service';
import { CostService } from './cost.service';
import { DataToolsService } from './data-tools.service';
import { ExpressService } from './express.service';
import { PricingDebugService } from './pricing-debug.service';
import { ResourcesService } from './resources.service';
import { readZipEntries } from './xlsx-lite';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('成本表与定价调试表（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let cost: CostService;
  let maintain: CostMaintainService;
  let debug: PricingDebugService;
  let boss: AuthUser;
  let ops: AuthUser; // 运营：只有定价调试表页面权限，没有成本权限
  const ids: Record<string, number> = {};

  const bundleRow = () => cost.one(boss, ids.bundle);
  const ceilMicro = (costFreight: number, micro: number) => Number((BigInt(costFreight) * 100_000_000n + BigInt(100_000_000 - micro) - 1n) / BigInt(100_000_000 - micro));

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test_a' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    cost = new CostService(ds);
    maintain = new CostMaintainService(ds, svc, new DataToolsService(ds, cost));
    debug = new PricingDebugService(cost);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `c${crypto.randomBytes(5).toString('hex')}`, name: '成本表测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    ops = { id: u.id, companyId: c.id, name: '运营', permissions: { isCompanyAdmin: false, allow: ['finance.pricing-debug.view'], deny: [] } };

    ids.rootCat = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果原料', code: 'SG' })).id;
    ids.leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: ids.rootCat })).id;
    const product = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '红富士苹果', categoryId: ids.leaf, purchaseSpec: '千克', specQty: 2.5, specUnit: 'KG', freight: 200, handlingFee: 50, purchasePrice: 9000 });
    ids.product = product.id;
    ids.unitWeight = (await svc.get(boss, 'finance-products', product.id)).data.weightG as number;
    const bc = await svc.create(boss, 'finance-base-codes', { productId: product.id });
    await svc.changeStatus(boss, 'finance-base-codes', bc.id, 'verified');
    const plat = await svc.create(boss, 'finance-platforms', { code: 'TB', name: '淘宝' });
    const scen = await svc.create(boss, 'finance-scenarios', { code: 'retail', name: '零售', segment: 'LS' });
    const bcat = (await svc.create(boss, 'finance-categories', { archiveType: 'bundle', name: '水果组合', code: 'SGZH' })).id;
    ids.bundle = (await svc.create(boss, 'finance-bundles', { platformId: plat.id, scenarioId: scen.id, bundleCategoryId: bcat })).id;
    await svc.create(boss, 'finance-bundle-lines', { bundleId: ids.bundle, role: 'main', baseCodeId: bc.id, qty: 1 });
    await svc.changeStatus(boss, 'finance-bundles', ids.bundle, 'verified');
    // 手工运费 8 元，避免依赖快递价格表
    await svc.update(boss, 'finance-bundles', ids.bundle, { manualFreight: 800, overrideReason: '测试固定运费' });
    // 第二个组合：同分类，没有手工运费、没有重量段报价 → 运费估不出来
    const b2 = await svc.create(boss, 'finance-bundles', { platformId: plat.id, scenarioId: scen.id, configNo: '02', bundleCategoryId: bcat });
    await svc.create(boss, 'finance-bundle-lines', { bundleId: b2.id, role: 'main', baseCodeId: bc.id, qty: 2 });
    await svc.changeStatus(boss, 'finance-bundles', b2.id, 'verified');
    ids.bundle2 = b2.id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('分类利润率可以保留 6 位小数，最低售价按全精度算（旧写法会先取整到 0.01%）', async () => {
    const before = await bundleRow();
    expect(before.marginPercent).toBeNull();
    expect(before.minPriceCents).toBeNull();
    const r = await maintain.saveCategoryMargin(boss, ids.leaf, { revision: 'none', profitPercent: 12.345678, reason: '精度测试' });
    expect(r.changed).toBe(true);
    const row = await bundleRow();
    expect(row.marginPercent).toBe(12.345678);
    expect(row.marginSource).toBe('本分类');
    const base = row.preShipCostCents! + 800;
    expect(row.minPriceCents).toBe(ceilMicro(base, 12_345_678));
    // 和取整到 12.35%（旧写法）的结果不同，说明精度没有丢
    expect(row.minPriceCents).not.toBe(Math.ceil((base * 10000) / (10000 - 1235)));
  });

  it('分类利润率的乐观锁：令牌过期（别人先改了）保存失败；“全部默认”也一样；恢复继承', async () => {
    const t1 = await cost.table(boss, { page: 1, pageSize: 20 });
    const leaf = t1.categories.find((c) => c.id === ids.leaf)!;
    expect(leaf.ownPercent).toBe(12.345678);
    expect(leaf.count).toBe(2);
    // 上级分类（没自己设利润率）也在目录里，数量包含下级；没有组合也没设利润率的分类不显示
    expect(t1.categories.find((c) => c.id === ids.rootCat)).toMatchObject({ count: 2, ownPercent: null, percent: null, source: '未设置' });
    // 两个人同时打开同一份令牌，第二个人保存时被拒绝
    await maintain.saveCategoryMargin(boss, ids.leaf, { revision: leaf.revision, profitPercent: 20, reason: 'A 改成 20' });
    await expect(maintain.saveCategoryMargin(boss, ids.leaf, { revision: leaf.revision, profitPercent: 30, reason: 'B 改成 30' })).rejects.toThrow(/已被别人更新/);
    expect((await bundleRow()).marginPercent).toBe(20);
    // 全部默认：第一次保存令牌是 none；再用 none 保存会冲突
    await maintain.saveCategoryMargin(boss, 0, { revision: 'none', profitPercent: 15, reason: '默认' });
    await expect(maintain.saveCategoryMargin(boss, 0, { revision: 'none', profitPercent: 16, reason: '重复' })).rejects.toThrow(/已被别人更新/);
    const t2 = await cost.table(boss, { page: 1, pageSize: 20 });
    expect(t2.defaultMargin.percent).toBe(15);
    // 恢复继承：本分类清空 → 沿用全部默认
    const leaf2 = t2.categories.find((c) => c.id === ids.leaf)!;
    await maintain.saveCategoryMargin(boss, ids.leaf, { revision: leaf2.revision, profitPercent: null, reason: '恢复继承' });
    const row = await bundleRow();
    expect(row.marginPercent).toBe(15);
    expect(row.marginSource).toBe('全部默认');
    const t3 = await cost.table(boss, { page: 1, pageSize: 20 });
    expect(t3.categories.find((c) => c.id === ids.leaf)).toMatchObject({ ownPercent: null, percent: 15, source: '全部默认' });
    // 校验：超过 6 位小数、100%、负数、没写原因
    for (const bad of [12.3456789, 100, -1]) {
      await expect(maintain.saveCategoryMargin(boss, ids.leaf, { revision: t3.categories.find((c) => c.id === ids.leaf)!.revision, profitPercent: bad, reason: 'x' })).rejects.toThrow(/利润率必须/);
    }
    await expect(maintain.saveCategoryMargin(boss, ids.leaf, { revision: 'none', profitPercent: 10, reason: '  ' })).rejects.toThrow(/修改原因/);
    await expect(maintain.saveCategoryMargin(boss, 999999, { revision: 'none', profitPercent: 10, reason: 'x' })).rejects.toThrow(/分类不存在/);
    // 分类利润率记录：谁、什么时候、从多少到多少、为什么
    const hist = await maintain.marginHistory(boss, { page: 1, pageSize: 20 });
    expect(hist.rows.length).toBeGreaterThanOrEqual(4);
    expect(hist.rows.some((h) => h.beforePercent === 12.345678 && h.afterPercent === 20 && h.reason === 'A 改成 20')).toBe(true);
    expect(hist.rows.some((h) => h.scopeName === '全部默认')).toBe(true);
  });

  it('维护售价：使用快递、单品利润率、原因必填、乐观锁；保存后成本表、成本历史、变更记录都跟着变', async () => {
    const row = await bundleRow();
    expect(row.carrierName).toBe('');
    expect(row.marginOverride).toBe(false);
    expect(row.inheritedMargin).toMatchObject({ percent: 15, source: '全部默认' });
    expect(row.costIncludingFreightCents).toBe(row.preShipCostCents! + 800);
    const saved = await maintain.savePricing(boss, ids.bundle, { revision: row.revision, carrierName: ' 顺丰 ', profitPercent: 33.333333, reason: '大客户专价' });
    expect(saved.changed).toBe(true);
    const after = await bundleRow();
    expect(after.carrierName).toBe('顺丰');
    expect(after.marginPercent).toBe(33.333333);
    expect(after.marginSource).toBe('本组合覆盖');
    expect(after.minPriceCents).toBe(ceilMicro(after.preShipCostCents! + 800, 33_333_333));
    expect(after.revision).not.toBe(row.revision);
    // 两个人同时在改：第二个人用旧令牌保存被拒绝，并且不会覆盖第一个人的结果
    await expect(maintain.savePricing(boss, ids.bundle, { revision: row.revision, carrierName: '中通', profitPercent: 10, reason: '后到的人' })).rejects.toThrow(/已变化/);
    expect((await bundleRow()).carrierName).toBe('顺丰');
    // 没有任何变化：不写、不记
    expect((await maintain.savePricing(boss, ids.bundle, { revision: after.revision, carrierName: '顺丰', profitPercent: 33.333333, reason: '没改' })).changed).toBe(false);
    // 校验
    const rv = after.revision;
    await expect(maintain.savePricing(boss, ids.bundle, { revision: rv, carrierName: 'x'.repeat(81), profitPercent: null, reason: '长' })).rejects.toThrow(/80/);
    await expect(maintain.savePricing(boss, ids.bundle, { revision: rv, carrierName: '', profitPercent: 99.9999999, reason: 'x' })).rejects.toThrow(/利润率必须/);
    await expect(maintain.savePricing(boss, ids.bundle, { revision: rv, carrierName: '', profitPercent: 100, reason: 'x' })).rejects.toThrow(/利润率必须/);
    await expect(maintain.savePricing(boss, ids.bundle, { revision: rv, carrierName: '', profitPercent: 5, reason: 'y'.repeat(301) })).rejects.toThrow(/300/);
    await expect(maintain.savePricing(boss, ids.bundle, { revision: rv, carrierName: '', profitPercent: 5, reason: '' })).rejects.toThrow(/修改原因/);
    await expect(maintain.savePricing(boss, 999999, { revision: rv, carrierName: '', profitPercent: 5, reason: 'x' })).rejects.toThrow(/不存在/);
    // 成本历史里多了一版，写着修改原因；售价维护记录里能看到使用快递的变化
    const snaps = await ds.manager.find(FinanceCostSnapshot, { where: { companyId: boss.companyId, bundleId: ids.bundle }, order: { id: 'DESC' } });
    expect(snaps[0].reason).toBe('大客户专价');
    expect(snaps[0].marginPercent).toBe(33.333333); // 数据库里也保留 6 位小数
    expect(snaps[0].minPriceCents).toBe(after.minPriceCents);
    const pricing = await maintain.pricingHistory(boss, { bundleId: ids.bundle, page: 1, pageSize: 20 });
    expect(pricing.total).toBe(1);
    expect(pricing.rows[0]).toMatchObject({ afterCarrier: '顺丰', beforeCarrier: '', afterPercent: 33.333333, beforePercent: null, reason: '大客户专价' });
    // 只改快递、不改价格：不会多出成本快照，但售价维护记录里有
    const snapCount = snaps.length;
    await maintain.savePricing(boss, ids.bundle, { revision: after.revision, carrierName: '中通', profitPercent: 33.333333, reason: '换快递' });
    expect(await ds.manager.count(FinanceCostSnapshot, { where: { companyId: boss.companyId, bundleId: ids.bundle } })).toBe(snapCount);
    expect((await maintain.pricingHistory(boss, { bundleId: ids.bundle, page: 1, pageSize: 20 })).total).toBe(2);
    const logs = await ds.manager.count(ResourceChangeLog, { where: { companyId: boss.companyId, resourceType: 'finance-bundles', resourceId: ids.bundle } });
    expect(logs).toBeGreaterThan(2);
    // 恢复继承
    const cur = await bundleRow();
    await maintain.savePricing(boss, ids.bundle, { revision: cur.revision, carrierName: '', profitPercent: null, reason: '恢复' });
    const back = await bundleRow();
    expect(back.marginOverride).toBe(false);
    expect(back.marginPercent).toBe(15);
    expect(back.carrierName).toBe('');
  });

  it('同时点保存只有一个人成功；归档的组合不能再维护售价；从资料页直接改单品利润率也会让旧令牌失效', async () => {
    const racing = await bundleRow();
    const results = await Promise.allSettled([
      maintain.savePricing(boss, ids.bundle, { revision: racing.revision, carrierName: '甲', profitPercent: 11, reason: '甲' }),
      maintain.savePricing(boss, ids.bundle, { revision: racing.revision, carrierName: '乙', profitPercent: 22, reason: '乙' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = await bundleRow();
    await maintain.savePricing(boss, ids.bundle, { revision: winner.revision, carrierName: '', profitPercent: null, reason: '还原' });
    await svc.changeStatus(boss, 'finance-bundles', ids.bundle2, 'archived', '测试归档');
    await expect(maintain.savePricing(boss, ids.bundle2, { revision: 'x', carrierName: '', profitPercent: 5, reason: 'x' })).rejects.toThrow(/归档/);
    await svc.changeStatus(boss, 'finance-bundles', ids.bundle2, 'verified');
    const row = await bundleRow();
    await svc.update(boss, 'finance-bundles', ids.bundle, { marginOverridePercent: 7, overrideReason: '资料页直接改' });
    await expect(maintain.savePricing(boss, ids.bundle, { revision: row.revision, carrierName: '', profitPercent: 9, reason: '旧令牌' })).rejects.toThrow(/已变化/);
    await svc.update(boss, 'finance-bundles', ids.bundle, { marginOverridePercent: null, overrideReason: '还原' });
  });

  it('成本表：分类目录带组合数（含下级）和继承到的利润率；列表按最近修改排序；运费估不出来显示待估价', async () => {
    const t = await cost.table(boss, { page: 1, pageSize: 20 });
    expect(t.canEdit).toBe(true);
    expect(t.allTotal).toBe(2);
    expect(t.rows.map((r) => r.bundleId)).toContain(ids.bundle2);
    const r2 = t.rows.find((r) => r.bundleId === ids.bundle2)!;
    expect(r2.freightCents).toBeNull();
    expect(r2.costIncludingFreightCents).toBeNull();
    expect(r2.minPriceCents).toBeNull();
    expect(r2.lines[0]).toMatchObject({ qty: 2, unitWeightG: ids.unitWeight, weightG: ids.unitWeight * 2 });
    const viewOnly: AuthUser = { ...boss, permissions: { isCompanyAdmin: false, allow: ['product.cost.view'], deny: [] } };
    expect((await cost.table(viewOnly, { page: 1, pageSize: 20 })).canEdit).toBe(false);
    const byCat = await cost.table(boss, { categoryId: ids.rootCat, page: 1, pageSize: 20 });
    expect(byCat.total).toBe(2); // 选上级分类包含下级
  });

  it('定价调试表：按重量由轻到重；成本查看者精确到分，运营看到整元且看不到发货前成本', async () => {
    const asBoss = await debug.list(boss, { page: 1, pageSize: 30 });
    expect(asBoss.canViewInternals).toBe(true);
    expect(asBoss.rows.map((r) => r.id)).toEqual([ids.bundle, ids.bundle2]); // 轻的在前
    expect(asBoss.rows[0].preShipCostCents).toBeGreaterThan(0);
    expect(asBoss.rows[0].ready).toBe(true);
    expect(asBoss.rows[1].ready).toBe(false); // 运费估不出来：暂不可试算
    const asOps = await debug.list(ops, { page: 1, pageSize: 30 });
    expect(asOps.canViewInternals).toBe(false);
    expect(asOps.rows[0]).not.toHaveProperty('preShipCostCents');
    expect(JSON.stringify(asOps)).not.toContain('preShipCostCents');
    // 按基础编码 / 分类筛选
    const bc = (await svc.list(boss, 'finance-base-codes', {})).items[0].id;
    expect((await debug.list(boss, { baseCodeId: bc, page: 1, pageSize: 30 })).total).toBe(2);
    expect((await debug.list(boss, { categoryId: ids.rootCat, page: 1, pageSize: 30 })).total).toBe(2);
    expect((await debug.list(boss, { baseCodeId: 999999, page: 1, pageSize: 30 })).total).toBe(0);
    expect((await debug.list(boss, { keyword: '不存在的关键字', page: 1, pageSize: 30 })).total).toBe(0);
    const comps = await debug.components(boss, { categoryId: ids.rootCat, page: 1 });
    expect(comps.rows.some((r) => r.id === bc)).toBe(true);
    expect(comps.categories.some((c) => c.id === ids.leaf)).toBe(true);
  });

  it('定价调试表：预留利润、投产与售价联动；手填利润金额按来源商品比例；运营整元', async () => {
    const row = await bundleRow();
    const floor = row.minPriceCents!;
    const s10 = await debug.sliderPrice(boss, { id: ids.bundle, step: 10 });
    expect(s10).toMatchObject({ available: true, priceCents: Math.ceil((floor * 110) / 100) });
    const sOps = await debug.sliderPrice(ops, { id: ids.bundle, step: 10 });
    expect(sOps.priceCents! % 100).toBe(0);
    expect(sOps.priceCents).toBeGreaterThanOrEqual(s10.priceCents!);
    await expect(debug.sliderPrice(boss, { id: ids.bundle, step: 141 })).rejects.toThrow(/档位/);
    expect((await debug.sliderPrice(boss, { id: ids.bundle2, step: 5 })).available).toBe(false);
    // 投产 → 售价 → 投产
    const q = await debug.quote(boss, 'roiToPrice', [{ id: ids.bundle, step: 10, value: 4 }]);
    expect(q.rows[0]).toMatchObject({ available: true, roi: 4, minPriceCents: floor });
    const price = (q.rows[0] as { priceCents: number }).priceCents;
    expect(price).toBe(Math.ceil((s10.priceCents! * 4) / 3));
    const back = await debug.quote(boss, 'priceToRoi', [{ id: ids.bundle, step: 10, value: price }]);
    expect(back.rows[0]).toMatchObject({ available: true, priceCents: price });
    const opsQuote = await debug.quote(ops, 'roiToPrice', [{ id: ids.bundle, step: 10, value: 4 }]);
    expect(opsQuote.rows[0]).not.toHaveProperty('minPriceCents'); // 运营看不到公司低价明细
    // 估不出运费的商品：提示原因而不是报错
    expect((await debug.quote(boss, 'roiToPrice', [{ id: ids.bundle2, step: 10, value: 4 }])).rows[0]).toMatchObject({ available: false });
    // 手填利润金额：以本商品为来源，利润 = 低价的 20%
    const amount = Math.round(floor * 0.2);
    const custom = await debug.sliderPrice(boss, { id: ids.bundle, step: 0, profit: { id: ids.bundle, amountCents: amount } });
    expect(custom).toMatchObject({ available: true, reservedProfitCents: custom.priceCents! - floor });
    expect(custom.step).toBe(20);
    await expect(debug.sliderPrice(boss, { id: ids.bundle, step: 0, profit: { id: ids.bundle, amountCents: floor * 6 } })).rejects.toThrow(/超出滑块/);
    await expect(debug.sliderPrice(boss, { id: ids.bundle, step: 0, profit: { id: 999999, amountCents: 100 } })).rejects.toThrow(/来源商品已变化/);
    await expect(debug.quote(boss, 'roiToPrice', [{ id: ids.bundle, step: 10, value: 1 }])).rejects.toThrow(/大于 1/);
  });

  it('导出 Excel：服务端重新核对，页面上的结果和现在不一致就拒绝（409）；表头和数据正确', async () => {
    const s = await debug.sliderPrice(boss, { id: ids.bundle, step: 10 });
    const q = (await debug.quote(boss, 'roiToPrice', [{ id: ids.bundle, step: 10, value: 4 }])).rows[0] as { priceCents: number; roi: number };
    const input = { id: ids.bundle, step: 10, mode: 'roiToPrice' as const, value: 4, sellingPriceCents: q.priceCents, roi: q.roi, sliderPriceCents: s.priceCents };
    const out = await debug.exportXlsx(boss, [input]);
    expect(out.rowCount).toBe(1);
    expect(out.fileName).toMatch(/^定价调试结果-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const files = readZipEntries(Buffer.from(out.fileBase64, 'base64'));
    expect(Object.keys(files)).toContain('xl/worksheets/sheet1.xml');
    const sheet = files['xl/worksheets/sheet1.xml'];
    for (const h of ['商品名称', 'SKU编码', '组合分类', '预留利润', '预留利润后售价', '最终试算售价', '目标投产', '预留利润比例', '公司低价']) expect(sheet).toContain(h);
    expect(sheet).toContain((q.priceCents / 100).toString());
    // 只调了滑块、没填投产/售价的也能导出
    expect((await debug.exportXlsx(boss, [{ id: ids.bundle, step: 10, mode: 'sliderPrice', sliderPriceCents: s.priceCents }])).rowCount).toBe(1);
    // 运营导出：没有“预留利润比例”列
    const opsSliderPrice = (await debug.sliderPrice(ops, { id: ids.bundle, step: 10 })).priceCents;
    const opsFile = readZipEntries(Buffer.from((await debug.exportXlsx(ops, [{ id: ids.bundle, step: 10, mode: 'sliderPrice', sliderPriceCents: opsSliderPrice }])).fileBase64, 'base64'));
    expect(opsFile['xl/worksheets/sheet1.xml']).not.toContain('预留利润比例');

    // 页面打开后，成本/利润率变了 → 导出被拒绝，要求重新试算
    const row = await bundleRow();
    await maintain.savePricing(boss, ids.bundle, { revision: row.revision, carrierName: '', profitPercent: 40, reason: '页面打开后改了利润率' });
    await expect(debug.exportXlsx(boss, [input])).rejects.toMatchObject({ status: 409 });
    await expect(debug.exportXlsx(boss, [{ id: ids.bundle, step: 10, mode: 'sliderPrice', sliderPriceCents: s.priceCents }])).rejects.toThrow(/已变化/);
    // 其他校验：空、重复、不存在的商品、估不出价格的商品
    await expect(debug.exportXlsx(boss, [])).rejects.toThrow(/最多 10000/);
    await expect(debug.exportXlsx(boss, [input, input])).rejects.toThrow(/最多 10000/);
    await expect(debug.exportXlsx(boss, [{ ...input, id: 999999 }])).rejects.toMatchObject({ status: 409 });
    await expect(debug.exportXlsx(boss, [{ id: ids.bundle2, step: 1, mode: 'sliderPrice', sliderPriceCents: 1 }])).rejects.toMatchObject({ status: 409 });
    // 新结果重新试算后可以导出
    const s2 = await debug.sliderPrice(boss, { id: ids.bundle, step: 10 });
    expect((await debug.exportXlsx(boss, [{ id: ids.bundle, step: 10, mode: 'sliderPrice', sliderPriceCents: s2.priceCents }])).rowCount).toBe(1);
  });
  it('运费和“预估运费一览”同一套引擎：版本可发货重量、手工金额、单包上限、拆包都一致', async () => {
    const ex = new ExpressService(ds, svc);
    const carrier = await svc.create(boss, 'finance-express-carriers', { name: '测试快递' });
    const branch = await svc.create(boss, 'finance-express-branches', { carrierId: carrier.id, name: '总部' });
    const version = await svc.create(boss, 'finance-express-versions', { branchId: branch.id, versionName: 'v1', shippingWeightMax: 5 });
    await svc.update(boss, 'finance-express-versions', version.id, { cooperationStatus: 'active' });
    await svc.create(boss, 'finance-express-prices', { versionId: version.id, province: 'ALL', shipWeightMin: 0, fixedPrice: 1000 });
    const live = async (g: number) => (await cost.freightEstimate(boss, g)).cents;
    const page = async (kg: number) => (await ex.getEstimates(boss)).rows.find((r) => kg > r.start && kg <= r.end && !r.parcels)!;
    // 与预估运费一览页同一个金额（固定价 10 元 ×1.1）
    const auto = (await page(4)).autoAmount;
    expect(auto).toBe(1100);
    expect(await live(4000)).toBe(auto);
    expect((await cost.freightEstimate(boss, 4000)).method).toMatch(/provincial/);
    // 版本只能发 5kg 以内：8kg 没有价格，不猜
    expect(await live(8000)).toBeNull();
    // 手工金额：成本表立刻跟着走
    await ex.setOverride(boss, 3, 4, 5000, '测试手工');
    expect(await live(4000)).toBe(5000);
    expect((await cost.freightEstimate(boss, 4000)).method).toBe('manual_override');
    expect(await live(3500)).toBe(5000);
    // 单包上限改为 3kg：7kg 拆成 3+3+1，手工金额只落在 (2,3] 段
    await ex.setOverride(boss, 3, 4, null, '取消');
    await ex.setParcelLimit(boss, 3);
    await ex.setOverride(boss, 2, 3, 5000, '测试手工');
    const split = await cost.freightEstimate(boss, 8000); // 3+3+2：两包手工 + (1,2] 段自动 1100
    expect(split.cents).toBe(5000 * 2 + 1100);
    expect(split.method).toBe('split_parcel_sum');
    // 成本表这一行也用同一个运费
    const r = await cost.one(boss, ids.bundle2);
    expect(r.freightCents).toBe((await cost.freightEstimate(boss, r.weightG!)).cents);
    // 分区建议来自新引擎的固定价建议
    const zones = await cost.zoneSuggestion(boss, 5);
    expect(zones.rows.length).toBeGreaterThan(0);
    expect(zones.rows[0]).toMatchObject({ carrier: '测试快递', branch: '总部', cents: 1000 });
  });
});
