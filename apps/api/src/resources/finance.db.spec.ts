/** 财务资料（商品档案、编码、组合、利润率）的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test npm test -w @kudesi/api -- finance.db */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { CostService } from './cost.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('财务资料（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let ops: AuthUser; // 运营：能管商品档案，但没有成本权限
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `f${crypto.randomBytes(5).toString('hex')}`, name: '财务测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    ops = { id: u.id, companyId: c.id, name: '运营', permissions: { isCompanyAdmin: false, allow: ['resource.finance-products.*', 'resource.finance-base-codes.*'], deny: [] } };

    ids.rawCat = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果原料', code: 'SG' })).id;
    ids.leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: ids.rawCat })).id;
    ids.smCat = (await svc.create(boss, 'finance-categories', { archiveType: 'self_made', name: '礼盒自制', code: 'LH' })).id;
    ids.brand = (await svc.create(boss, 'finance-brands', { name: '果园先生' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('分类：编码规范、自动沿用上级类型、最多 4 级、不能给有商品的分类加下级', async () => {
    await expect(svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '坏码', code: 'a-b' })).rejects.toThrow(/分类码/);
    const child = await svc.get(boss, 'finance-categories', ids.leaf);
    expect(child.data.archiveType).toBe('raw');
    const l1 = await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '另一棵树', code: 'T1' });
    const l2 = await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '二级', code: 'T2', parentId: l1.id });
    const l3 = await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '三级', code: 'L3', parentId: l2.id });
    const l4 = await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '四级', code: 'L4', parentId: l3.id });
    await expect(svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '五级', code: 'L5', parentId: l4.id })).rejects.toThrow(/最多 4 级/);
    await expect(svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'XX' })).rejects.toThrow(/已存在/);
  });

  it('分类目录：列表显示完整路径、点上级含下级、目录带数量', async () => {
    const p = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '路径测试苹果', purchaseSpec: '千克', specQty: 3, specUnit: 'KG', categoryId: ids.leaf, purchasePrice: 100, freight: 1, handlingFee: 1 });
    expect(p.refLabels.categoryId).toBe('水果原料 / 苹果类');
    const byParent = await svc.list(boss, 'finance-products', { filters: JSON.stringify({ categoryId: String(ids.rawCat) }) });
    expect(byParent.items.some((i) => i.id === p.id)).toBe(true);
    const tree = await svc.categoryTree(boss, 'finance-products', 'categoryId', { tab: 'raw' });
    const parent = tree.nodes.find((n) => n.id === ids.rawCat)!;
    const leaf = tree.nodes.find((n) => n.id === ids.leaf)!;
    expect(leaf.parentId).toBe(ids.rawCat);
    expect(parent.count).toBeGreaterThanOrEqual(1);
    expect(parent.count).toBeGreaterThanOrEqual(leaf.count);
    expect(tree.nodes.some((n) => n.id === ids.smCat)).toBe(false); // 别的板块的分类不出现
    const tabPurchased = await svc.categoryTree(boss, 'finance-products', 'categoryId', { tab: 'purchased' });
    expect(tabPurchased.nodes.some((n) => n.id === ids.rawCat)).toBe(false);
  });

  it('OEM 包装有自己独立的分类树，和产品包装不混用', async () => {
    const pk = await svc.create(boss, 'finance-categories', { archiveType: 'package', name: '独立树测试包装', code: 'DL1' });
    const oem = await svc.create(boss, 'finance-categories', { archiveType: 'oem_package', name: '独立树测试OEM', code: 'DL2' });
    const base = { archiveType: 'oem_package', name: 'OEM袋子', capacities: '1KG', weightG: 25, purchaseSpec: '个', specQty: 1, specUnit: 'EA', purchasePrice: 10, freight: 1, handlingFee: 1, brandId: ids.brand };
    await expect(svc.create(boss, 'finance-products', { ...base, categoryId: pk.id })).rejects.toThrow(/不匹配/);
    const ok = await svc.create(boss, 'finance-products', { ...base, categoryId: oem.id });
    expect(ok.refLabels.categoryId).toBe('独立树测试OEM');
    const tree = await svc.categoryTree(boss, 'finance-products', 'categoryId', { tab: 'oem_package' });
    expect(tree.nodes.some((n) => n.id === oem.id)).toBe(true);
    expect(tree.nodes.some((n) => n.id === pk.id)).toBe(false);
  });

  it('商品档案：必须挂最末级分类、类型匹配、自动生成编码、零值要说明、总成本自动算', async () => {
    const base = { archiveType: 'raw', name: '红富士苹果', purchaseSpec: '千克', specQty: 2.5, specUnit: 'KG', freight: 100, handlingFee: 50, supplierId: undefined };
    await expect(svc.create(boss, 'finance-products', { ...base, categoryId: ids.rawCat })).rejects.toThrow(/最末级/);
    await expect(svc.create(boss, 'finance-products', { ...base, categoryId: ids.smCat })).rejects.toThrow(/不匹配/);
    await expect(svc.create(boss, 'finance-products', { ...base, categoryId: ids.leaf, purchasePrice: 0, freight: 100, handlingFee: 50 })).rejects.toThrow(/零值说明/);
    const p = await svc.create(boss, 'finance-products', { ...base, categoryId: ids.leaf, purchasePrice: 1000, freight: 200, handlingFee: 50 });
    expect(p.data.code).toBe('YL-SGPG-HFSPG-2D5KG');
    expect(p.data.totalCost).toBe(1250);
    ids.apple = p.id;
    // 同样的商品再建一个：自动编码加序号，不是报错
    const p2 = await svc.create(boss, 'finance-products', { ...base, name: '红富士苹果', categoryId: ids.leaf, purchasePrice: 900, freight: 100, handlingFee: 0, zeroValueReason: '装卸费：供应商承担' });
    expect(p2.data.code).toBe('YL-SGPG-HFSPG-2D5KG-2');
    ids.apple2 = p2.id;
    await expect(svc.create(boss, 'finance-products', { ...base, code: 'bad code', categoryId: ids.leaf })).rejects.toThrow(/商品编码/);
    // 有商品的分类不能再加下级
    await expect(svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '不行', code: 'NO', parentId: ids.leaf })).rejects.toThrow(/已经挂了商品/);
  });

  it('成本字段服务端按权限隐藏：没有 product.cost.view 的人，列表、详情、日志里都没有；也不能改', async () => {
    const seen = await svc.get(ops, 'finance-products', ids.apple);
    expect(seen.data.totalCost).toBeUndefined();
    expect(seen.data.purchasePrice).toBeUndefined();
    expect(seen.data.name).toBe('红富士苹果');
    const list = await svc.list(ops, 'finance-products', {});
    expect(JSON.stringify(list)).not.toContain('1250');
    await svc.update(ops, 'finance-products', ids.apple, { name: '红富士苹果（改）', purchasePrice: 99999 });
    const asBoss = await svc.get(boss, 'finance-products', ids.apple);
    expect(asBoss.data.purchasePrice).toBe(1000); // 运营提交的成本被丢弃
    expect(asBoss.data.name).toBe('红富士苹果（改）');
    const logs = await svc.logs(ops, 'finance-products', ids.apple);
    expect(JSON.stringify(logs)).not.toContain('purchasePrice');
    const csv = await svc.exportCsv(ops, 'finance-products', false);
    expect(csv.csv).not.toContain('采购价');
  });

  it('基础编码：自动生成、一个商品只能一个、验证要求重量和成本，商品成本一变就“需重新验证”', async () => {
    const bc = await svc.create(boss, 'finance-base-codes', { productId: ids.apple });
    expect(bc.data.code).toBe('SG-PG-HFSPGG-2D5KG');
    expect(bc.status).toBe('pending');
    ids.bc = bc.id;
    await expect(svc.create(boss, 'finance-base-codes', { productId: ids.apple })).rejects.toThrow(/已经有基础编码/);
    await expect(svc.create(boss, 'finance-base-codes', { productId: ids.apple2, code: 'MANUAL-1' })).rejects.toThrow(/原因/);
    const noWeight = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '无重量', categoryId: ids.leaf, purchaseSpec: '袋', weightManual: true, weightG: 0, specQty: 1, specUnit: 'KG', purchasePrice: 100, freight: 0, handlingFee: 1, zeroValueReason: '运费：包邮' });
    const bc2 = await svc.create(boss, 'finance-base-codes', { productId: noWeight.id });
    await expect(svc.changeStatus(boss, 'finance-base-codes', bc2.id, 'verified')).rejects.toThrow(/重量/);
    const ok = await svc.changeStatus(boss, 'finance-base-codes', bc.id, 'verified');
    expect(ok.status).toBe('verified');
    expect(String(ok.data.signature)).toHaveLength(24);
    await svc.update(boss, 'finance-products', ids.apple, { purchasePrice: 1100 });
    expect((await svc.get(boss, 'finance-base-codes', bc.id)).status).toBe('reverify');
    await svc.changeStatus(boss, 'finance-base-codes', bc.id, 'verified');
  });

  it('自制品：成本和重量按构成自动汇总，组件成本一变也跟着变；构成不能成环', async () => {
    const box = await svc.create(boss, 'finance-products', { archiveType: 'self_made', name: '苹果礼盒', categoryId: ids.smCat, brandId: ids.brand, specQty: 1, specUnit: 'BOX', freight: 300, handlingFee: 100 });
    await svc.create(boss, 'finance-product-boms', { productId: box.id, componentId: ids.apple, qty: 2, lossPercent: 10 });
    const after = await svc.get(boss, 'finance-products', box.id);
    // 苹果 1100+200+50=1350；2×1.1×1350=2970；+运费 300 +装卸 100 = 3370
    expect(after.data.totalCost).toBe(3370);
    expect(after.data.weightG).toBe(2000);
    await svc.update(boss, 'finance-products', ids.apple, { purchasePrice: 1200 });
    expect((await svc.get(boss, 'finance-products', box.id)).data.totalCost).toBe(Math.round(2 * 1.1 * 1450) + 400);
    await expect(svc.create(boss, 'finance-product-boms', { productId: ids.apple, componentId: box.id, qty: 1 })).rejects.toThrow(/只有自制品/);
    await expect(svc.create(boss, 'finance-product-boms', { productId: box.id, componentId: box.id, qty: 1 })).rejects.toThrow(/自己/);
    ids.box = box.id;
  });

  it('组合编码：按主品/赠品/平台/场景自动生成编码和名称，只能加已验证的基础编码，构成变了需重新验证', async () => {
    // 前面苹果成本改过，基础编码处于“需重新验证”：必须先重新验证才能进组合
    await expect(svc.create(boss, 'finance-bundle-lines', { bundleId: (await svc.create(boss, 'finance-bundles', { platformId: (await svc.create(boss, 'finance-platforms', { code: 'PRE', name: '预检' })).id, scenarioId: (await svc.create(boss, 'finance-scenarios', { code: 'pre', name: '预检场景' })).id })).id, role: 'main', baseCodeId: ids.bc, qty: 1 })).rejects.toThrow(/还没验证/);
    await svc.changeStatus(boss, 'finance-base-codes', ids.bc, 'verified');
    const plat = await svc.create(boss, 'finance-platforms', { code: 'TB', name: '淘宝' });
    const scen = await svc.create(boss, 'finance-scenarios', { code: 'supply_chain', name: '供应链', segment: 'GYL' });
    const bcat = await svc.create(boss, 'finance-categories', { name: '水果组合', code: 'SGZH', archiveType: 'bundle' });
    ids.bcat = bcat.id;
    const bundle = await svc.create(boss, 'finance-bundles', { platformId: plat.id, scenarioId: scen.id, bundleCategoryId: bcat.id });
    expect(String(bundle.data.code)).toMatch(/^ZH-待配置-/);
    const apple2Bc = await svc.create(boss, 'finance-base-codes', { productId: ids.apple2, code: 'APPLE-B', codeChangeReason: '历史编码' });
    await expect(svc.create(boss, 'finance-bundle-lines', { bundleId: bundle.id, role: 'main', baseCodeId: apple2Bc.id, qty: 1 })).rejects.toThrow(/还没验证/);
    await svc.create(boss, 'finance-bundle-lines', { bundleId: bundle.id, role: 'main', baseCodeId: ids.bc, qty: 2 });
    const mid = await svc.get(boss, 'finance-bundles', bundle.id);
    expect(mid.data.code).toBe('ZH-TB-HFSPGG-5KG-GYL');
    expect(mid.data.name).toBe('组合-苹果类-红富士苹果（改）-5千克');
    await svc.update(boss, 'finance-products', ids.apple2, { weightG: 100 });
    await svc.changeStatus(boss, 'finance-base-codes', apple2Bc.id, 'verified');
    await expect(svc.create(boss, 'finance-bundle-lines', { bundleId: bundle.id, role: 'gift', baseCodeId: apple2Bc.id, qty: 1 })).rejects.toThrow(/赠品简称/);
    await svc.update(boss, 'finance-products', ids.apple2, { giftShortName: '苹果赠', giftCodeShortName: 'apple' });
    const gift = await svc.create(boss, 'finance-bundle-lines', { bundleId: bundle.id, role: 'gift', baseCodeId: apple2Bc.id, qty: 1 });
    expect((await svc.get(boss, 'finance-bundles', bundle.id)).data.code).toBe('ZH-TB-HFSPGG-5KG-GYL+ZP-APPLE*1');
    const verified = await svc.changeStatus(boss, 'finance-bundles', bundle.id, 'verified');
    expect(verified.status).toBe('verified');
    // 构成一变，就要重新验证；删除赠品后编码回到只有主品
    await svc.remove(boss, 'finance-bundle-lines', gift.id, '不要赠品了');
    const back = await svc.get(boss, 'finance-bundles', bundle.id);
    expect(back.status).toBe('reverify');
    expect(back.data.code).toBe('ZH-TB-HFSPGG-5KG-GYL');
    // 手工重量/运费/利润率覆盖必须写原因
    await expect(svc.update(boss, 'finance-bundles', bundle.id, { manualFreight: 800 })).rejects.toThrow(/原因/);
    await svc.update(boss, 'finance-bundles', bundle.id, { manualFreight: 800, overrideReason: '特殊线路' });
    ids.bundle = bundle.id;
  });

  it('利润率：全部默认和分类各一条，同一范围不能重复，必须写原因', async () => {
    await expect(svc.create(boss, 'finance-margins', { profitPercent: 20 })).rejects.toThrow(/原因/);
    const all = await svc.create(boss, 'finance-margins', { profitPercent: 20, reason: '默认' });
    expect(all.title).toBe('全部默认利润率');
    await expect(svc.create(boss, 'finance-margins', { profitPercent: 25, reason: '重复' })).rejects.toThrow(/已存在/);
    await expect(svc.create(boss, 'finance-margins', { categoryId: ids.bcat, profitPercent: 100, reason: 'x' })).rejects.toThrow(/不含 100/);
    const cat = await svc.create(boss, 'finance-margins', { categoryId: ids.bcat, profitPercent: 30.5, reason: '水果利润高' });
    expect(cat.data.scopeKey).toBe(`cat:${ids.bcat}`);
  });
  it('成本表：现算成本、重量、运费、利润率来源和最低售价；成本一变立刻跟着变', async () => {
    const cost = new CostService(ds);
    const prod = await svc.get(boss, 'finance-products', ids.apple);
    const unit = prod.data.totalCost as number;
    const row = await cost.one(boss, ids.bundle);
    expect(row.preShipCostCents).toBe(unit * 2);
    expect(row.weightG).toBe(2 * (prod.data.weightG as number));
    expect(row.freightCents).toBe(800);
    expect(row.freightMethod).toBe('手工填写');
    expect(row.marginPercent).toBe(30.5);
    expect(row.marginSource).toBe('本分类');
    expect(row.minPriceCents).toBe(Math.ceil(((unit * 2 + 800) * 10000) / (10000 - 3050)));
    // 本组合利润率覆盖优先
    await svc.update(boss, 'finance-bundles', ids.bundle, { marginOverridePercent: 10, overrideReason: '走量' });
    expect((await cost.one(boss, ids.bundle)).marginSource).toBe('本组合覆盖');
    await svc.update(boss, 'finance-bundles', ids.bundle, { marginOverridePercent: null, overrideReason: '恢复' });
    // 没有手工运费：按快递价格表估算（5 个省，每省 10 元）
    await svc.update(boss, 'finance-bundles', ids.bundle, { manualFreight: null, overrideReason: '改按价格表' });
    expect((await cost.one(boss, ids.bundle)).freightCents).toBeNull();
    for (const [i, province] of ['北京', '上海', '广东', '浙江', '江苏'].entries()) {
      await svc.create(boss, 'finance-express-prices', { carrier: `快递${i}`, province, fixedPrice: 1000 });
    }
    const est = await cost.one(boss, ids.bundle);
    expect(est.freightCents).toBe(1100);
    // 商品成本变 -> 成本表立刻变
    await svc.update(boss, 'finance-products', ids.apple, { purchasePrice: (prod.data.purchasePrice as number) + 100 });
    expect((await cost.one(boss, ids.bundle)).preShipCostCents).toBe(unit * 2 + 200);
    const table = await cost.table(boss, { keyword: 'zh-tb', page: 1, pageSize: 20 });
    expect(table.rows.some((r) => r.bundleId === ids.bundle)).toBe(true);
  });
  it('商品档案：按分类（含下级）和供货方式筛选；批量改分类、批量停用；失败的单独返回', async () => {
    const byRoot = await svc.list(boss, 'finance-products', { fieldKey: 'categoryId', fieldValue: String(ids.rawCat) });
    expect(byRoot.items.some((x) => x.id === ids.apple)).toBe(true); // 选上级分类能看到下级的商品
    const byMode = await svc.list(boss, 'finance-products', { filters: JSON.stringify({ categoryId: String(ids.leaf) }) });
    expect(byMode.items.some((x) => x.id === ids.apple)).toBe(true);
    await expect(svc.batchUpdate(boss, 'finance-products', [ids.apple], { name: '乱改' })).rejects.toThrow(/不能批量/);
    const r = await svc.batchUpdate(boss, 'finance-products', [ids.apple, 999999], { categoryId: ids.smCat });
    expect(r.done).toBe(0); // 原料不能挪到自制分类；不存在的也失败
    expect(r.failed).toHaveLength(2);
    const s = await svc.batchUpdate(boss, 'finance-products', [ids.apple2], {}, 'inactive', '测试停用');
    expect(s.failed).toEqual([]);
    expect(s.done).toBe(1);
    expect((await svc.get(boss, 'finance-products', ids.apple2)).status).toBe('inactive');
    await svc.changeStatus(boss, 'finance-products', ids.apple2, 'active');
  });
  it('供应商/客户/费用档案：自动编号、多分类、分类最多 4 级、挂账节点推出“必须挂对象”', async () => {
    const c1 = await svc.create(boss, 'finance-supplier-categories', { name: '种子供应商' });
    const c2 = await svc.create(boss, 'finance-supplier-categories', { name: '玉米', parentId: c1.id });
    const c3 = await svc.create(boss, 'finance-supplier-categories', { name: '甜玉米', parentId: c2.id });
    const c4 = await svc.create(boss, 'finance-supplier-categories', { name: '四级', parentId: c3.id });
    await expect(svc.create(boss, 'finance-supplier-categories', { name: '太深', parentId: c4.id })).rejects.toThrow(/最多 4 级/);
    const s1 = await svc.create(boss, 'finance-suppliers', { name: '润农种业', shortName: '润农', categoryIds: [c1.id, c4.id] });
    expect(s1.data.code).toBe('GYS-ZZGYS-SJ-RNZY');
    expect(s1.data.shortCode).toBe('RN');
    expect(s1.refLabels.categoryIds).toBe('种子供应商、种子供应商 / 玉米 / 甜玉米 / 四级');
    const s2 = await svc.create(boss, 'finance-suppliers', { name: '另一家', categoryIds: [c4.id] });
    expect(s2.data.code).toBe('GYS-ZZGYS-SJ-LYJ');
    await expect(svc.create(boss, 'finance-suppliers', { name: '没选分类' })).rejects.toThrow(/分类/);
    await expect(svc.create(boss, 'finance-suppliers', { name: '坏分类', categoryIds: [999999] })).rejects.toThrow(/不存在/);
    const k = await svc.create(boss, 'finance-customers', { name: '老客户' });
    expect(k.data.code).toBe('KH-001');
    await svc.create(boss, 'finance-fee-items', { code: 'FY-990', name: '手填编号', direction: 'expense', defaultObject: '公司' }); // 避开默认数据的编号
    const f1 = await svc.create(boss, 'finance-fee-items', { name: '办公软件测试', direction: 'expense', defaultObject: '公司' });
    expect(f1.data.code).toBe('FY-991');
    expect(f1.data.requiredObject).toBe('no');
    const f2 = await svc.create(boss, 'finance-fee-items', { name: '手机卡', direction: 'offset', defaultObject: '手机号、店铺', requiredObject: 'no' });
    expect(f2.data.requiredObject).toBe('yes');
    expect(f2.data.defaultObject).toBe('店铺、手机号'); // 按选项顺序
    const f3 = await svc.create(boss, 'finance-fee-items', { name: '无节点', direction: 'current' });
    expect(f3.data.defaultObject).toBe('不固定');
  });
});
