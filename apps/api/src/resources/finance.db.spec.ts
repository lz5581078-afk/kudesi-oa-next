/** 财务资料（商品档案、编码、组合、利润率）的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test npm test -w @kudesi/api -- finance.db */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { buildSnapshot } from './base-code-support';
import { getResourceDef } from '@kudesi/shared';
import { ExpressService } from './express.service';
import { CostService } from './cost.service';
import { ResourcesService } from './resources.service';
import { previewProductCode } from './finance-rules';

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

  it.each(['suppliers', 'customers'])('往来单位 %s 列表只展示直属分类，分页和导出不混入下级，目录仍有汇总计数', async (kind) => {
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `direct${crypto.randomBytes(5).toString('hex')}`, name: '直属测试隔离公司', status: 'active' }));
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '测试管理员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    const actor = { ...boss, id: user.id, companyId: company.id };
    const type = `finance-${kind}`;
    const catType = kind === 'suppliers' ? 'finance-supplier-categories' : 'finance-customer-categories';
    const root = await svc.create(actor, catType, { name: `直属测试${kind}` });
    const child = await svc.create(actor, catType, { name: '末级目录', parentId: root.id });
    const party = await svc.create(actor, type, { name: `直属单位${kind}`, categoryIds: [child.id] });
    const q = { filters: JSON.stringify({ categoryIds: String(root.id) }), pageSize: 1 };
    expect((await svc.list(actor, type, q)).total).toBe(0);
    expect((await svc.exportCsv(actor, type, false, q)).csv).not.toContain(party.title);
    const direct = await svc.list(actor, type, { filters: JSON.stringify({ categoryIds: String(child.id) }) });
    expect(direct.total).toBe(1);
    expect(direct.items[0].id).toBe(party.id);
    const tree = await svc.categoryTree(actor, type, 'categoryIds', {});
    expect(tree.nodes.find(node => node.id === root.id)?.count).toBe(1);
    expect(tree.nodes.find(node => node.id === root.id)?.directCount).toBe(0);
    expect(tree.nodes.find(node => node.id === child.id)?.directCount).toBe(1);
    expect((await svc.list({ ...actor, companyId: 999999999 }, type, q)).total).toBe(0);
  });

  it('供货来源只因采购价修改切换最新成本，非价格修改保留时间且兼容旧记录', async () => {
    const supplier = await svc.create(boss, 'finance-suppliers', { name: '报价时序测试供应商' });
    const product = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '报价时序苹果', categoryId: ids.leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 100, freight: 1, handlingFee: 1 });
    const a = await svc.create(boss, 'finance-product-sources', { productId: product.id, supplierId: supplier.id, originArea: '甲产区', purchasePrice: 100 });
    const b = await svc.create(boss, 'finance-product-sources', { productId: product.id, supplierId: supplier.id, originArea: '乙产区', purchasePrice: 200 });
    // 固定合成记录的时间，避免依赖机器时钟和毫秒先后。
    for (const [id, priceUpdatedAt] of [[a.id, '2020-01-01T00:00:00Z'], [b.id, '2021-01-01T00:00:00Z']] as const) {
      const record = await ds.manager.findOneByOrFail(ResourceRecord, { id });
      await ds.manager.update(ResourceRecord, { id }, { data: { ...record.data, priceUpdatedAt } });
    }
    const edited = await svc.update(boss, 'finance-product-sources', a.id, { originArea: '甲产区修正' });
    expect(edited.data.priceUpdatedAt).toBe('2020-01-01T00:00:00Z');
    expect((await svc.get(boss, 'finance-products', product.id)).data.purchasePrice).toBe(200);
    const repriced = await svc.update(boss, 'finance-product-sources', a.id, { purchasePrice: 300 });
    expect(new Date(String(repriced.data.priceUpdatedAt)).getTime()).toBeGreaterThan(new Date('2021-01-01').getTime());
    expect((await svc.get(boss, 'finance-products', product.id)).data.purchasePrice).toBe(300);
    const legacy = await ds.manager.findOneByOrFail(ResourceRecord, { id: b.id });
    delete legacy.data.priceUpdatedAt;
    await ds.manager.query('UPDATE resource_records SET data = ?, updated_at = ? WHERE id = ? AND company_id = ?', [JSON.stringify(legacy.data), '2019-01-01 00:00:00', b.id, boss.companyId]);
    const legacyTime = (await ds.manager.findOneByOrFail(ResourceRecord, { id: b.id })).updatedAt.toISOString();
    const legacyEdited = await svc.update(boss, 'finance-product-sources', b.id, { originArea: '旧记录产区修正' });
    expect(legacyEdited.data.priceUpdatedAt).toBe(legacyTime);
    expect((await svc.get(boss, 'finance-products', product.id)).data.purchasePrice).toBe(300);
    await expect(svc.update({ ...boss, companyId: 999999999 }, 'finance-product-sources', a.id, { purchasePrice: 999 })).rejects.toThrow();
  });

  it('发货物料文字规格贯穿保存、基础名称、编码与导入导出', async () => {
    const category = await svc.create(boss, 'finance-categories', { archiveType: 'shipping_material', name: '文字规格测试类', code: 'WZGG' });
    const data = { archiveType: 'shipping_material', name: '合成气泡袋', categoryId: category.id, specQty: '25*33+4', specUnit: 'EA', weightG: 10, purchasePrice: 100, freight: 5, handlingFee: 1 };
    const product = await svc.create(boss, 'finance-products', data);
    expect(product.data.specQty).toBe('25*33+4');
    expect(product.data.basicInfoFullName).toContain('25*33+4');
    expect(product.data.code).toContain('-25334EA');
    const bases = await svc.list(boss, 'finance-base-codes', { fieldKey: 'productId', fieldValue: String(product.id) });
    expect(bases.items[0].data.code).toContain('-25334EA');
    expect(bases.items[0].data.spec).toBe('25*33+4EA');
    const snapshot = await buildSnapshot(ds.manager, boss.companyId, await ds.manager.findOneByOrFail(ResourceRecord, { id: bases.items[0].id }));
    expect(snapshot.snapshot.archives[0].specQty).toBe('25*33+4');
    expect(snapshot.issues.some(i => i.message.includes('规格'))).toBe(false);
    expect((await svc.exportCsv(boss, 'finance-products', false, { fieldKey: 'categoryId', fieldValue: String(category.id) })).csv).toContain('25*33+4');
    const def = getResourceDef('finance-products')!;
    const converted = await (svc as any).rowToInput(ds.manager, boss, def, { '档案类型': '发货物料档案', '规格数量': '25*33+4' });
    expect(converted.errors).toEqual([]);
    expect(converted.input.specQty).toBe('25*33+4');
    await svc.update(boss, 'finance-products', product.id, { name: '合成气泡袋改名' });
    expect((await svc.get(boss, 'finance-products', product.id)).data.specQty).toBe('25*33+4');
  });

  it('发货物料小数按文字取码，纯符号规格保留单位；预览和保存一致，既有编码不重写', async () => {
    const category = await svc.create(boss, 'finance-categories', { archiveType: 'shipping_material', name: '符号编码测试类', code: 'FHFB' });
    const data = { archiveType: 'shipping_material', name: '合成规格袋', categoryId: category.id, specQty: '2.50', specUnit: 'CM', weightG: 10, purchasePrice: 100, freight: 5, handlingFee: 1 };
    const preview = await previewProductCode(ds.manager, svc, boss, data, null);
    expect(preview.code).toMatch(/-250CM$/);
    const created = await svc.create(boss, 'finance-products', data);
    expect(created.data.code).toBe(preview.code);
    const symbols = await svc.create(boss, 'finance-products', { ...data, name: '合成符号袋', specQty: '*+*' });
    expect(symbols.data.code).toMatch(/-CM$/);
    const legacy = await svc.create(boss, 'finance-products', { ...data, name: '合成历史袋', code: 'FH-LEGACY-2D5CM' });
    expect((await svc.update(boss, 'finance-products', legacy.id, { name: '合成历史袋改名' })).data.code).toBe('FH-LEGACY-2D5CM');
    const raw = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '合成数字原料', categoryId: ids.leaf, specQty: 2.5, specUnit: 'KG', purchaseSpec: '千克', purchasePrice: 100, freight: 5, handlingFee: 1 });
    expect(raw.data.code).toMatch(/-2D5KG$/);
  });

  it('采购与自产按文字名称规格、包装规格及系统规格分段编码，预览与保存一致', async () => {
    const cat = await svc.create(boss, 'finance-categories', { archiveType: 'original_purchase', name: '分段采购类', code: 'FDCG' });
    const purchased = { archiveType: 'purchased', supplyMode: 'original_purchase', name: '分段采购', categoryId: cat.id, brandId: ids.brand, specQty: '2.50', specUnit: 'G', purchaseSpec: '袋', purchasePrice: 100, freight: 1, handlingFee: 1 };
    const preview = await previewProductCode(ds.manager, svc, boss, purchased, null);
    expect(preview.code).toMatch(/-250G-D$/);
    expect((await svc.create(boss, 'finance-products', purchased)).data.code).toBe(preview.code);
    const made = { archiveType: 'self_made', name: '分段自产', categoryId: ids.smCat, brandId: ids.brand, specQty: '混合2.50', specUnit: 'BOX', productPackagingSpec: '500g袋', productPackagingUnit: 'D', purchaseSpec: '千克' };
    const madePreview = await previewProductCode(ds.manager, svc, boss, made, null);
    expect(madePreview.code).toMatch(/-HH250BOX-500GDD-QK$/);
    const saved = await svc.create(boss, 'finance-products', made);
    expect(saved.data.code).toBe(madePreview.code);
    expect(saved.data.basicInfoFullName).toBe(madePreview.basicInfoFullName);
    expect(saved.data.basicInfoFullName).toContain('-500g袋-袋-千克');
    expect((await svc.update(boss, 'finance-products', saved.id, { purchaseSpec: '斤', productPackagingUnit: 'BOX' })).data.code).toBe(saved.data.code);
    const noNameSpec = { ...made, name: '无名称规格分段', specQty: '', specUnit: '', productPackagingSpec: '500', productPackagingUnit: 'D' };
    const emptyPreview = await previewProductCode(ds.manager, svc, boss, noNameSpec, null);
    expect(emptyPreview.code).toMatch(/-500D-QK$/);
    expect((await svc.create(boss, 'finance-products', noNameSpec)).data.code).toBe(emptyPreview.code);
  });

  it('采购和自产文字名称规格不丢失，采购自动重量随名称规格变化重新计算', async () => {
    const cat = await svc.create(boss, 'finance-categories', { archiveType: 'original_purchase', name: '文字采购规格', code: 'WZCG' });
    const purchased = await svc.create(boss, 'finance-products', { archiveType: 'purchased', supplyMode: 'original_purchase', name: '合成采购测试', categoryId: cat.id, brandId: ids.brand, specQty: '净含量500g', specUnit: 'EA', purchaseSpec: '袋', purchasePrice: 100, freight: 1, handlingFee: 1 });
    expect(purchased.data).toMatchObject({ specQty: '净含量500g', weightG: 500 });
    const changed = await svc.update(boss, 'finance-products', purchased.id, { specQty: '25*33+4' });
    expect(changed.data.weightG).toBeUndefined();
    const manual = await svc.update(boss, 'finance-products', purchased.id, { weightManual: true, weightG: 123 });
    expect(manual.data.weightG).toBe(123);
    const made = await svc.create(boss, 'finance-products', { archiveType: 'self_made', name: '合成自产测试', categoryId: ids.smCat, brandId: ids.brand, specQty: '混合装', specUnit: 'BOX' });
    expect(made.data.specQty).toBe('混合装');
    expect(made.data.basicInfoFullName).toContain('混合装');
    expect(made.data.code).toContain('-HHZBOX');
    const oemCat = await svc.create(boss, 'finance-categories', { archiveType: 'supplier_oem', name: '文字OEM规格', code: 'WZOEM' });
    const oem = await svc.create(boss, 'finance-products', { archiveType: 'purchased', supplyMode: 'supplier_oem', name: '合成OEM测试', categoryId: oemCat.id, brandId: ids.brand, specQty: '净含量500g', specUnit: 'EA', purchaseSpec: '袋', oemPackageWeightG: 25, purchasePrice: 100, freight: 1, handlingFee: 1 });
    expect(oem.data.weightG).toBe(525);
  });

  it('发货物料来源系统规格独立维护，随当前报价传到档案及成本，且删除维护项不改历史来源', async () => {
    const category = await svc.create(boss, 'finance-categories', { archiveType: 'shipping_material', name: '来源计量测试类', code: 'JLDW' });
    const product = await svc.create(boss, 'finance-products', { archiveType: 'shipping_material', name: '计量测试胶带', categoryId: category.id, specQty: 1, specUnit: 'EA', weightG: 10, freight: 5, handlingFee: 1 });
    const supplier = await svc.create(boss, 'finance-suppliers', { name: '物料计量测试商' });
    const unitA = await svc.create(boss, 'finance-product-units', { kind: 'shipping_system_spec', name: '合成卷' });
    const unitB = await svc.create(boss, 'finance-product-units', { kind: 'shipping_system_spec', name: '合成张' });
    await expect(svc.create(boss, 'finance-product-sources', { productId: product.id, supplierId: supplier.id, purchasePrice: 100, systemSpec: '合成卷' })).rejects.toThrow(/产区/);
    await expect(svc.create(boss, 'finance-product-sources', { productId: product.id, supplierId: supplier.id, originArea: '山东', purchasePrice: 100 })).rejects.toThrow(/系统规格/);
    const a = await svc.create(boss, 'finance-product-sources', { productId: product.id, supplierId: supplier.id, originArea: '山东', purchasePrice: 100, systemSpec: '合成卷' });
    const b = await svc.create(boss, 'finance-product-sources', { productId: product.id, supplierId: supplier.id, originArea: '浙江', purchasePrice: 200, systemSpec: '合成张' });
    for (const [id, priceUpdatedAt] of [[a.id, '2020-01-01T00:00:00Z'], [b.id, '2021-01-01T00:00:00Z']] as const) {
      const record = await ds.manager.findOneByOrFail(ResourceRecord, { id });
      await ds.manager.update(ResourceRecord, { id }, { data: { ...record.data, priceUpdatedAt } });
    }
    await svc.update(boss, 'finance-product-sources', a.id, { originArea: '产区修正' });
    expect((await svc.get(boss, 'finance-products', product.id)).data).toMatchObject({ purchasePrice: 200, purchaseSpec: '合成张', totalCost: 206 });
    await svc.update(boss, 'finance-product-sources', a.id, { purchasePrice: 150 });
    expect((await svc.get(boss, 'finance-products', product.id)).data).toMatchObject({ purchasePrice: 150, purchaseSpec: '合成卷', totalCost: 156 });
    const costs = await svc.list(boss, 'finance-product-costs', { fieldKey: 'productId', fieldValue: String(product.id) });
    expect(costs.items.some(row => row.data.sourceType === 'raw_supply_source' && row.data.unitName === '合成卷')).toBe(true);
    await svc.update(boss, 'finance-products', product.id, { name: '计量测试胶带改名' });
    expect((await svc.get(boss, 'finance-products', product.id)).data.purchaseSpec).toBe('合成卷');
    // 原系统规格管理删除名称，不更改已经使用该名称的历史资料。
    await svc.remove(boss, 'finance-product-units', unitB.id, '删除维护名称');
    expect((await svc.get(boss, 'finance-product-sources', b.id)).data.systemSpec).toBe('合成张');
    expect((await svc.get(boss, 'finance-products', product.id)).data.purchaseSpec).toBe('合成卷');
    const rawUnit = await svc.create(boss, 'finance-product-units', { kind: 'system_spec', name: '合成原料规格' });
    const raw = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '规格删除测试原料', categoryId: ids.leaf, purchaseSpec: '合成原料规格', specQty: 1, specUnit: 'KG', weightManual: true, weightG: 10, freight: 1, handlingFee: 1 });
    await svc.remove(boss, 'finance-product-units', rawUnit.id, '删除维护项保留历史');
    expect((await svc.get(boss, 'finance-products', raw.id)).data.purchaseSpec).toBe('合成原料规格');
    const options = await svc.unitOptions(boss);
    expect(options.shipping_system_spec.map(option => option.value)).toEqual(expect.arrayContaining(['合成卷', '合成张']));
    expect(options.system_spec.map(option => option.value)).toContain('合成原料规格');
    expect(options.system_spec.map(option => option.value)).not.toContain('合成张');
    const reused = await svc.create(boss, 'finance-product-sources', { productId: product.id, supplierId: supplier.id, originArea: '历史规格复用产区', purchasePrice: 180, systemSpec: '合成张' });
    expect(reused.data.systemSpec).toBe('合成张');
    const reusedRaw = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '历史规格复用原料', categoryId: ids.leaf, purchaseSpec: '合成原料规格', specQty: 1, specUnit: 'KG', weightManual: true, weightG: 10, freight: 1, handlingFee: 1 });
    expect(reusedRaw.data.purchaseSpec).toBe('合成原料规格');
    expect(await svc.unitOptions({ ...boss, companyId: boss.companyId + 9999999 })).toEqual({});
    expect(unitA.data.code).toBeUndefined();
  });

  it('分类：编码规范、自动沿用上级类型、最多 4 级、不能给有商品的分类加下级', async () => {
    await expect(svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '坏码', code: 'a-b' })).rejects.toThrow(/分类码/);
    const child = await svc.get(boss, 'finance-categories', ids.leaf);
    expect(child.data.archiveType).toBe('raw');
    const l1 = await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '另一棵树', code: 'T1' });
    const l2 = await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '二级', code: 'T2', parentId: l1.id });
    const l3 = await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '三级', code: 'L3', parentId: l2.id });
    const l4 = await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '四级', code: 'L4', parentId: l3.id });
    await expect(svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '五级', code: 'L5', parentId: l4.id })).rejects.toThrow(/最多 4 级/);
    await expect(svc.create(boss, 'finance-categories', { archiveType: 'raw', parentId: ids.rawCat, name: '苹果类', code: 'XX' })).rejects.toThrow(/已存在/);
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
    expect(p.data.code).toBe('YL-SG-PG-HFSPG-2D5KG');
    expect(p.data.totalCost).toBe(1250);
    ids.apple = p.id;
    // 同样的商品再建一个：自动编码加序号，不是报错
    const p2 = await svc.create(boss, 'finance-products', { ...base, name: '红富士苹果', categoryId: ids.leaf, purchasePrice: 900, freight: 100, handlingFee: 0, zeroValueReason: '装卸费：供应商承担' });
    expect(p2.data.code).toBe('YL-SG-PG-HFSPG-2D5KG-2');
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
    // 样本须由明确重算保存，读取SKU成本不会自动创建快递样本。
    await new ExpressService(ds,svc).recalculate(boss);
    const est = await cost.one(boss, ids.bundle);
    expect(est.freightCents).toBe(1100);
    expect(est.lines.find(line => line.role === 'main')?.unitName).toBe(prod.data.purchaseSpec);
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
    expect(s2.data.shortName).toBe('另一家');
    const previewValues = { name: '编号预览测试', shortName: '预览', categoryIds: [c4.id] };
    const preview = await svc.codePreview(boss, 'finance-suppliers', previewValues);
    expect(await svc.codePreview(boss, 'finance-suppliers', previewValues)).toEqual(preview); // 预览不占号
    const previewSaved = await svc.create(boss, 'finance-suppliers', previewValues);
    expect(previewSaved.data.code).toBe(preview.code);
    expect(previewSaved.data.shortCode).toBe(preview.shortCode);
    await expect(svc.codePreview(ops, 'finance-suppliers', previewValues)).rejects.toThrow(/权限/);
    await expect(svc.codePreview({ ...boss, companyId: 999999999 }, 'finance-suppliers', previewValues)).rejects.toThrow(/不存在/);
    await expect(svc.codePreview(boss, 'finance-suppliers', { categoryIds: Array(11).fill(c4.id) })).rejects.toThrow(/分类不合法/);
    await expect(svc.create(boss, 'finance-suppliers', { name: '没选分类' })).rejects.toThrow(/分类/);
    await expect(svc.create(boss, 'finance-suppliers', { name: '坏分类', categoryIds: [999999] })).rejects.toThrow(/不存在/);
    const k = await svc.create(boss, 'finance-customers', { name: '老客户' });
    expect(k.data.code).toBe('KH-001');
    await svc.create(boss, 'finance-fee-items', { code: 'FY-990', name: '手填编号', direction: 'expense', defaultObject: '公司' }); // 避开默认数据的编号
    const f1 = await svc.create(boss, 'finance-fee-items', { name: '办公软件测试', direction: 'expense', defaultObject: '公司' });
    expect(f1.data.code).toBe('FY-991');
    expect(f1.data.requiredObject).toBe('no');
    const f2 = await svc.create(boss, 'finance-fee-items', { name: '手机卡', direction: 'offset', defaultObject: '手机号、店铺', requiredObject: 'no' });
    expect(f2.data.requiredObject).toBe('no'); // 原档案允许明确设置；节点变更仍联动
    expect(f2.data.defaultObject).toBe('手机号、店铺'); // 原选择顺序决定制单时的首个默认节点
    const f3 = await svc.create(boss, 'finance-fee-items', { name: '无节点', direction: 'current' });
    expect(f3.data.defaultObject).toBe('不固定');
    const derived=await svc.create(boss,'finance-fee-items',{name:'未指定必挂要求',defaultObject:'店铺'});
    expect(derived.data.requiredObject).toBe('yes');
  });
});
