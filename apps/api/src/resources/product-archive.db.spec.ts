/** 商品档案与基础编码补齐（赠品简称、基础信息全称、多构成基础编码、档案保存自动同步、引用锁定、档案成本记录、运费历史）。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('商品档案与基础编码（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let ops: AuthUser;
  const ids: Record<string, number> = {};
  let brandCode = '';

  const mkRaw = (over: Record<string, unknown> = {}) =>
    svc.create(boss, 'finance-products', { archiveType: 'raw', name: '苹果', categoryId: ids.leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 100, handlingFee: 50, ...over });
  const baseCodesOf = async (productId: number) =>
    (await svc.list(boss, 'finance-base-codes', { fieldKey: 'productId', fieldValue: productId, pageSize: 50 } as never)).items as Array<{ id: number; status: string; data: Record<string, unknown> }>;

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `d${crypto.randomBytes(5).toString('hex')}`, name: '商品档案补齐测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    ops = { id: u.id, companyId: c.id, name: '运营', permissions: { isCompanyAdmin: false, allow: ['resource.finance-products.*', 'resource.finance-base-codes.*', 'resource.finance-base-code-lines.*'], deny: [] } };
    const root = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' })).id;
    ids.leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: root })).id;
    ids.pkgCat = (await svc.create(boss, 'finance-categories', { archiveType: 'package', name: '礼盒', code: 'LH' })).id;
    const brand = await svc.create(boss, 'finance-brands', { name: '果园先生' });
    ids.brand = brand.id;
    brandCode = String(brand.data.code);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('赠品简称、赠品编码简称：规范化、格式校验、跨档案排重；只有原料/外购成品/发货物料有', async () => {
    const a = await mkRaw({ name: '赠品苹果', giftShortName: ' 红苹果 ', giftCodeShortName: 'hpg1' });
    expect(a.data.giftShortName).toBe('红苹果');
    expect(a.data.giftCodeShortName).toBe('HPG1');
    await expect(mkRaw({ name: '赠品苹果二', giftShortName: '红 苹果' })).rejects.toThrow(/赠品简称已被其他商品使用/);
    await expect(mkRaw({ name: '赠品苹果三', giftCodeShortName: 'HPG1' })).rejects.toThrow(/赠品编码简称已被其他商品使用/);
    await expect(mkRaw({ name: '赠品苹果四', giftShortName: '苹果×2' })).rejects.toThrow(/连接符/);
    await expect(mkRaw({ name: '赠品苹果五', giftCodeShortName: 'a-b' })).rejects.toThrow(/英文字母和数字/);
    // 自己改自己不算重复；删除的商品不占名额
    await svc.update(boss, 'finance-products', a.id, { giftShortName: '红苹果', note: 'x' });
    const b = await mkRaw({ name: '待删赠品', giftShortName: '待删简称' });
    await svc.changeStatus(boss, 'finance-products', b.id, 'deleted', '不要了');
    await mkRaw({ name: '再用简称', giftShortName: '待删简称' });
    // 自产成品没有赠品简称
    const sm = await svc.create(boss, 'finance-categories', { archiveType: 'self_made', name: '自产类', code: 'ZC1' });
    const made = await svc.create(boss, 'finance-products', { archiveType: 'self_made', name: '自产礼', categoryId: sm.id, brandId: ids.brand, specQty: 1, specUnit: 'BOX', giftShortName: '不应保存', freight: 0, handlingFee: 0, zeroValueReason: '运费：自提\n装卸费：无' });
    expect(made.data.giftShortName).toBeUndefined();
  });

  it('生产编码与基础信息全称：按档案类型拼，原料马甲名称用生产编码', async () => {
    const raw = await mkRaw({ name: '丰花1号', specQty: 2, specUnit: 'J', materialCode: ' SC01 ', rawFinishedNames: '丰花礼盒' });
    expect(raw.data.materialCode).toBe('SC01');
    expect(raw.data.basicInfoFullName).toBe('丰花1号-2-斤-SC01');
    const aliases = (await baseCodesOf(raw.id)).filter((r) => r.data.canonicalId);
    expect(aliases.map((a) => a.data.name)).toEqual(['丰花礼盒-2J-SC01']);
    const pkg = await svc.create(boss, 'finance-products', { archiveType: 'package', name: '礼盒', categoryId: ids.pkgCat, brandId: ids.brand, packagingCategory: 'box', dimensions: '20×15×8', dimensionUnit: 'cm', capacities: '500ML\n1KG', specQty: 1, specUnit: 'EA', purchasePrice: 300, freight: 10, handlingFee: 5 });
    expect(pkg.data.basicInfoFullName).toBe('盒-礼盒-果园先生-20×15×8-厘米-500ML-1KG');
  });

  it('档案保存自动同步基础编码：没有就建待验证编码，名称跟着档案走，手改过就不再跟；手工新建会取代占位', async () => {
    const p = await mkRaw({ name: '同步苹果' });
    const first = await baseCodesOf(p.id);
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe('pending');
    expect(first[0].data.origin).toBe('archive_sync');
    expect(first[0].data.name).toBe('同步苹果-1-千克');
    await svc.update(boss, 'finance-products', p.id, { name: '同步苹果改' });
    const synced = (await baseCodesOf(p.id))[0];
    expect(synced.data.name).toBe('同步苹果改-1-千克');
    // 手改名称后不再跟随
    await svc.update(boss, 'finance-base-codes', synced.id, { name: '我自己起的名' });
    await svc.update(boss, 'finance-products', p.id, { name: '同步苹果又改' });
    expect((await baseCodesOf(p.id))[0].data.name).toBe('我自己起的名');
    // 自产成品、OEM 包装不自动建
    const sm = await svc.create(boss, 'finance-categories', { archiveType: 'self_made', name: '自产类2', code: 'ZC2' });
    const made = await svc.create(boss, 'finance-products', { archiveType: 'self_made', name: '自产不同步', categoryId: sm.id, brandId: ids.brand, specQty: 1, specUnit: 'BOX', freight: 0, handlingFee: 0, zeroValueReason: '运费：自提\n装卸费：无' });
    expect(await baseCodesOf(made.id)).toHaveLength(0);
    // 手工新建取代没人动过的占位
    const p2 = await mkRaw({ name: '占位苹果' });
    const placeholder = (await baseCodesOf(p2.id))[0];
    const manual = await svc.create(boss, 'finance-base-codes', { productId: p2.id });
    expect(manual.id).not.toBe(placeholder.id);
    expect(await baseCodesOf(p2.id)).toHaveLength(1);
    await expect(svc.create(boss, 'finance-base-codes', { productId: p2.id })).rejects.toThrow(/已经有基础编码/);
  });

  it('多构成基础编码：主要商品自动成第一行，成本重量按构成汇总，不能重复添加；可和别的编码共用来源商品', async () => {
    const a = await mkRaw({ name: '构成甲', purchasePrice: 1000, freight: 0, handlingFee: 0, zeroValueReason: '运费：自提\n装卸费：无', specQty: 1, specUnit: 'KG' });
    const b = await mkRaw({ name: '构成乙', purchasePrice: 500, freight: 0, handlingFee: 0, zeroValueReason: '运费：自提\n装卸费：无', specQty: 2, specUnit: 'KG' });
    const base = { origin: 'composed', productId: a.id, name: '甲乙礼盒', shortName: '甲乙礼盒', varietyName: '甲乙礼盒', codeCategoryId: ids.leaf, codeBrandId: ids.brand, codeSpecQty: 1, codeSpecUnit: 'BOX' };
    await expect(svc.create(boss, 'finance-base-codes', { ...base, codeSpecQty: 0 })).rejects.toThrow(/大于 0/);
    await expect(svc.create(boss, 'finance-base-codes', { ...base, varietyName: '' })).rejects.toThrow(/品种/);
    const bc = await svc.create(boss, 'finance-base-codes', base);
    expect(String(bc.data.code)).toMatch(/^SG-PG-[A-Z0-9]+-[A-Z0-9]+-1BOX$/);
    // 主要商品自动成第一行
    const lines = async () => (await svc.list(boss, 'finance-base-code-lines', { fieldKey: 'baseCodeId', fieldValue: bc.id, pageSize: 50 } as never)).items as Array<{ id: number; data: Record<string, unknown> }>;
    expect((await lines()).map((l) => [l.data.productId, l.data.qty, l.data.role])).toEqual([[a.id, 1, 'main']]);
    await svc.create(boss, 'finance-base-code-lines', { baseCodeId: bc.id, productId: b.id, qty: 2, role: 'auxiliary' });
    await expect(svc.create(boss, 'finance-base-code-lines', { baseCodeId: bc.id, productId: b.id, qty: 1 })).rejects.toThrow(/不能重复/);
    await expect(svc.create(boss, 'finance-base-code-lines', { baseCodeId: bc.id, productId: b.id, qty: 0 })).rejects.toThrow(/大于 0/);
    const fresh = await svc.get(boss, 'finance-base-codes', bc.id);
    // 甲 1000 + 乙 500×2 = 2000；重量 原料按系统规格“千克”= 1000g：甲 1000 + 乙 1000×2 = 3000g
    expect(fresh.data.cost).toBe(2000);
    expect(fresh.data.weightG).toBe(3000);
    // 主要商品那一行不能去掉
    const mainLine = (await lines()).find((l) => l.data.productId === a.id)!;
    await expect(svc.remove(boss, 'finance-base-code-lines', mainLine.id, '去掉')).rejects.toThrow(/主要商品/);
    // 档案各有自己的占位编码，多构成不占用“一个商品一个编码”
    expect((await baseCodesOf(a.id)).filter((r) => r.data.origin === 'archive_sync')).toHaveLength(1);
    // 验证 → 组成商品涨价 → 需重新验证；组成变了也要重新验证
    await svc.changeStatus(boss, 'finance-base-codes', bc.id, 'verified');
    await svc.update(boss, 'finance-products', b.id, { purchasePrice: 600 });
    expect((await svc.get(boss, 'finance-base-codes', bc.id)).status).toBe('reverify');
    expect((await svc.get(boss, 'finance-base-codes', bc.id)).data.cost).toBe(2200);
    await svc.changeStatus(boss, 'finance-base-codes', bc.id, 'verified');
    const extra = await svc.create(boss, 'finance-base-code-lines', { baseCodeId: bc.id, productId: (await mkRaw({ name: '构成丙' })).id, qty: 1 });
    expect((await svc.get(boss, 'finance-base-codes', bc.id)).status).toBe('reverify');
    await svc.remove(boss, 'finance-base-code-lines', extra.id, '不要了');
    // 单品编码不能有构成行
    const single = (await baseCodesOf(a.id)).find((r) => !r.data.origin || r.data.origin === 'archive_sync')!;
    await expect(svc.create(boss, 'finance-base-code-lines', { baseCodeId: single.id, productId: b.id, qty: 1 })).rejects.toThrow(/多构成/);
    ids.composed = bc.id;
  });

  it('基础编码被引用锁定：有已验证组合引用后，编码和构成不能改，只能改名称简称；被已验证组合引用不能停用', async () => {
    await svc.changeStatus(boss, 'finance-base-codes', ids.composed, 'verified');
    const plat = await svc.create(boss, 'finance-platforms', { code: 'TB', name: '淘宝' });
    const scen = await svc.create(boss, 'finance-scenarios', { code: 'standard', name: '标准' });
    const bcat = (await svc.create(boss, 'finance-categories', { archiveType: 'bundle', name: '组合类', code: 'ZHL' })).id;
    const bundle = await svc.create(boss, 'finance-bundles', { platformId: plat.id, scenarioId: scen.id, bundleCategoryId: bcat });
    await svc.create(boss, 'finance-bundle-lines', { bundleId: bundle.id, role: 'main', baseCodeId: ids.composed, qty: 1 });
    // 草稿引用：还可以改
    await svc.update(boss, 'finance-base-codes', ids.composed, { name: '甲乙礼盒改名' });
    if ((await svc.get(boss, 'finance-base-codes', ids.composed)).status !== 'verified') await svc.changeStatus(boss, 'finance-base-codes', ids.composed, 'verified');
    await svc.changeStatus(boss, 'finance-bundles', bundle.id, 'verified');
    expect((await svc.get(boss, 'finance-bundles', bundle.id)).status).toBe('verified');
    await expect(svc.update(boss, 'finance-base-codes', ids.composed, { code: 'NEW-CODE', codeChangeReason: '改' })).rejects.toThrow(/生效引用/);
    await expect(svc.update(boss, 'finance-base-codes', ids.composed, { codeSpecQty: 2 })).rejects.toThrow(/生效引用/);
    await svc.update(boss, 'finance-base-codes', ids.composed, { name: '甲乙礼盒再改名', shortName: '礼盒简称' });
    await expect(svc.changeStatus(boss, 'finance-base-codes', ids.composed, 'disabled', '停用')).rejects.toThrow(/已验证的组合/);
    const lines = (await svc.list(boss, 'finance-base-code-lines', { fieldKey: 'baseCodeId', fieldValue: ids.composed, pageSize: 50 } as never)).items as Array<{ id: number; data: Record<string, unknown> }>;
    const aux = lines.find((l) => l.data.role === 'auxiliary')!;
    await expect(svc.update(boss, 'finance-base-code-lines', aux.id, { qty: 5 })).rejects.toThrow(/生效引用/);
    await expect(svc.remove(boss, 'finance-base-code-lines', aux.id, '去掉')).rejects.toThrow(/生效引用/);
  });

  it('档案成本记录：按成本类型和生效日期保存，启用记录日期不能重叠，手工锁定要写原因，最新成本显示在档案上', async () => {
    const p = await mkRaw({ name: '成本苹果', purchasePrice: undefined as never });
    const rec = (over: Record<string, unknown>) => svc.create(boss, 'finance-product-costs', { productId: p.id, costType: 'transfer', unitCost: 300, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', ...over });
    await expect(rec({ unitCost: -1 })).rejects.toThrow(/非负数/);
    await expect(rec({ effectiveTo: '2025-12-31' })).rejects.toThrow(/不能早于/);
    await expect(rec({ effectiveFrom: '2026-02-30' })).rejects.toThrow(/格式无效/);
    await expect(rec({ manualOverride: true })).rejects.toThrow(/锁定原因/);
    await expect(rec({ sourceType: 'archive_purchase_price' })).rejects.toThrow(/系统自动/);
    const r1 = await rec({});
    expect(r1.data.sourceType).toBe('manual');
    await expect(rec({ effectiveFrom: '2026-06-01', effectiveTo: '2026-12-31' })).rejects.toThrow(/重叠/);
    // 不同类型、或停用的记录不冲突
    await rec({ costType: 'express', effectiveFrom: '2026-06-01', unitCost: 700 });
    const r2 = await rec({ effectiveFrom: '2026-07-01', effectiveTo: undefined, unitCost: 350, manualOverride: true, manualLockReason: '财务定价' });
    const prod = await svc.get(boss, 'finance-products', p.id);
    expect(prod.data.latestUnitCost).toBe(350);
    expect(prod.data.latestCostType).toBe('transfer');
    expect(prod.data.latestCostFrom).toBe('2026-07-01');
    await svc.remove(boss, 'finance-product-costs', r2.id, '录错了');
    expect((await svc.get(boss, 'finance-products', p.id)).data.latestCostFrom).toBe('2026-06-01');
    // 没有成本权限的人看不到金额
    const seen = await svc.get(ops, 'finance-product-costs', r1.id);
    expect(seen.data.unitCost).toBeUndefined();
  });

  it('档案采购价/供货来源自动同步采购成本记录；手工锁定的不覆盖；运费历史只在变化时自动追加', async () => {
    const pkg = await svc.create(boss, 'finance-products', { archiveType: 'package', name: '同步包装', categoryId: ids.pkgCat, brandId: ids.brand, packagingCategory: 'bag', capacities: '1KG', specQty: 1, specUnit: 'EA', purchasePrice: 300, freight: 10, handlingFee: 5 });
    const costs = async (id: number, type = 'purchase') => ((await svc.list(boss, 'finance-product-costs', { fieldKey: 'productId', fieldValue: id, pageSize: 50 } as never)).items as Array<{ id: number; status: string; data: Record<string, unknown> }>).filter((r) => r.data.costType === type);
    let rows = await costs(pkg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].data.sourceType).toBe('archive_purchase_price');
    expect(rows[0].data.unitCost).toBe(300);
    // 同一天改价：更新同一条
    await svc.update(boss, 'finance-products', pkg.id, { purchasePrice: 320 });
    rows = await costs(pkg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].data.unitCost).toBe(320);
    // 手工锁定后不覆盖
    await svc.update(boss, 'finance-product-costs', rows[0].id, { manualOverride: true, manualLockReason: '定价' });
    await svc.update(boss, 'finance-products', pkg.id, { purchasePrice: 400 });
    expect((await costs(pkg.id))[0].data.unitCost).toBe(320);
    // 运费历史：首次保存一条，再改运费又一条，没变不追加
    const hist = async (id: number) => (await svc.list(boss, 'finance-product-freight-history', { fieldKey: 'productId', fieldValue: id, pageSize: 50 } as never)).items as Array<{ id: number; data: Record<string, unknown> }>;
    expect(await hist(pkg.id)).toHaveLength(3); // 建档一条；采购价是快照的一部分，改价（320、400）各追加一条
    await svc.update(boss, 'finance-products', pkg.id, { note: '没变' });
    const n = (await hist(pkg.id)).length;
    await svc.update(boss, 'finance-products', pkg.id, { freight: 20 });
    const after = await hist(pkg.id);
    expect(after).toHaveLength(n + 1);
    expect(after.some((h) => h.data.freight === 20)).toBe(true);
    // 手工不能新增/删除运费历史
    await expect(svc.create(boss, 'finance-product-freight-history', { productId: pkg.id, freight: 1 })).rejects.toThrow(/自动记录/);
    await expect(svc.remove(boss, 'finance-product-freight-history', after[0].id, '删除测试')).rejects.toThrow(/不能删除/);
    // 原料：取最新供货来源采购价
    const sup = await svc.create(boss, 'finance-suppliers', { name: '润农' });
    const raw = await mkRaw({ name: '来源苹果', purchasePrice: undefined as never });
    await svc.create(boss, 'finance-product-sources', { productId: raw.id, supplierId: sup.id, originArea: '山东', purchasePrice: 888 });
    const rawCosts = await costs(raw.id);
    expect(rawCosts.some((r) => r.data.sourceType === 'raw_supply_source' && r.data.unitCost === 888)).toBe(true);
  });

  it('相似提示：只和同一档案类型的比，名称相同/相似给提示；品牌和单位显示成名称；分类码、品牌码不能重复', async () => {
    await mkRaw({ name: '阳光玫瑰葡萄', specQty: 2, specUnit: 'J' });
    const same = await svc.similarCheck(boss, 'finance-products', { archiveType: 'raw', name: '阳光玫瑰葡萄', specQty: 2, specUnit: 'J' });
    expect(same.warnings[0].text).toContain('名称完全相同');
    const alike = await svc.similarCheck(boss, 'finance-products', { archiveType: 'raw', name: '阳光玫瑰葡萄干', specQty: 1, specUnit: 'KG' });
    expect(alike.warnings[0].warnings.join()).toMatch(/名称相似/);
    expect(alike.warnings[0].text).toContain('规格单位（本次：千克；已有：斤）');
    // 别的档案类型不比
    const other = await svc.similarCheck(boss, 'finance-products', { archiveType: 'package', name: '阳光玫瑰葡萄' });
    expect(other.warnings).toHaveLength(0);
    await expect(svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果二', code: 'SG' })).rejects.toThrow(/分类码 SG 已被“水果”使用，请换一个，例如 SG2/);
    await expect(svc.create(boss, 'finance-brands', { name: '果园先生二', code: brandCode })).rejects.toThrow(/品牌码 .* 已被“果园先生”使用/);
    // 自己保存自己不算重复
    await svc.update(boss, 'finance-brands', ids.brand, { name: '果园先生', code: brandCode });
  });

  it('零值原因库：商品档案“零值说明”里写过的原因自动入库，重复不重复入；可手工维护', async () => {
    await mkRaw({ name: '零值苹果', purchasePrice: 1000, freight: 0, handlingFee: 0, zeroValueReason: '运费：产地自提\n装卸费：  产地自提 ' });
    await mkRaw({ name: '零值苹果二', purchasePrice: 1000, freight: 0, handlingFee: 50, zeroValueReason: '运费：产地自提' });
    const rows = (await svc.list(boss, 'finance-zero-reasons', { pageSize: 50 } as never)).items as Array<{ title: string }>;
    expect(rows.filter((r) => r.title === '产地自提')).toHaveLength(1);
    await svc.create(boss, 'finance-zero-reasons', { reason: ' 客户  自备 ' });
    await expect(svc.create(boss, 'finance-zero-reasons', { reason: '客户 自备' })).rejects.toThrow(/已存在|重复/);
    await expect(svc.create(boss, 'finance-zero-reasons', { reason: '   ' })).rejects.toThrow();
  });
});
