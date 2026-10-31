/** 外购成品拆回旧系统的两个入口：原装采购成品 / 供应商 OEM 成品（同一张档案表，按采购方式分页签，各自一棵分类树）。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('外购成品两个页签（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  const ids: Record<string, number> = {};
  const mk = (over: Record<string, unknown>) =>
    svc.create(boss, 'finance-products', { archiveType: 'purchased', purchaseSpec: '箱', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 10, handlingFee: 10, brandId: ids.brand, ...over });

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `p${crypto.randomBytes(5).toString('hex')}`, name: '外购页签测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    ids.brand = (await svc.create(boss, 'finance-brands', { name: '页签品牌' })).id;
    ids.origCat = (await svc.create(boss, 'finance-categories', { archiveType: 'original_purchase', name: '干果', code: 'GG' })).id;
    ids.oemCat = (await svc.create(boss, 'finance-categories', { archiveType: 'supplier_oem', name: '干果', code: 'GO' })).id; // 两棵树同名不冲突
    ids.rawCat = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '原料树', code: 'YL' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('同一上级分类不能重名，不同树或不同目录允许同名', async () => {
    await expect(svc.create(boss, 'finance-categories', { archiveType: 'original_purchase', name: ' 干果 ', code: 'GG2' })).rejects.toThrow(/同一上级/);
    await expect(svc.create(boss, 'finance-categories', { archiveType: 'supplier_oem', name: '干果', code: 'GO2' })).rejects.toThrow(/同一上级/);
    await expect(svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '原料树', code: 'YL2' })).rejects.toThrow(/已存在/);
    const other = await svc.create(boss, 'finance-categories', { archiveType: 'original_purchase', name: '零食', code: 'LS' });
    const child = await svc.create(boss, 'finance-categories', { archiveType: 'original_purchase', name: '坚果', code: 'JG', parentId: other.id });
    await expect(svc.update(boss, 'finance-categories', child.id, { name: '干果' })).resolves.toMatchObject({ data: { name: '干果' } });
  });

  it('页签按采购方式拆开：原装采购页签含没填采购方式的老数据，供应商 OEM 页签只含 OEM；页签数量同口径；编码段 YZ / OEM', async () => {
    const orig = await mk({ name: '原装腰果', supplyMode: 'original_purchase', categoryId: ids.origCat });
    const oem = await mk({ name: 'OEM腰果', supplyMode: 'supplier_oem', categoryId: ids.oemCat, oemPackageWeightG: 100 });
    const raw = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '生腰果', categoryId: ids.rawCat, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1, freight: 1, handlingFee: 1 });
    // 旧迁入的数据：采购方式为空（旧系统视为原装采购）
    const legacy = await mk({ name: '老数据腰果', supplyMode: 'original_purchase', categoryId: ids.origCat });
    const rec = await ds.manager.findOneByOrFail(ResourceRecord, { id: legacy.id, companyId: boss.companyId });
    const { supplyMode: _drop, ...rest } = rec.data as Record<string, unknown>;
    rec.data = rest;
    await ds.manager.save(rec);

    expect(orig.data.code).toContain('-YZ-');
    expect(oem.data.code).toContain('-OEM-');
    const names = async (tab: string) => (await svc.list(boss, 'finance-products', { tab, pageSize: 100 })).items.map((i) => i.title).sort();
    expect(await names('original_purchase')).toEqual(['原装腰果', '老数据腰果']);
    expect(await names('supplier_oem')).toEqual(['OEM腰果']);
    expect(await names('purchased')).toEqual(['OEM腰果', '原装腰果', '老数据腰果']); // 旧的合并页签值仍可用
    expect(await names('raw')).toEqual(['生腰果']);
    const all = await svc.list(boss, 'finance-products', { pageSize: 100 });
    expect(all.tabCounts).toMatchObject({ original_purchase: 2, supplier_oem: 1, raw: 1 });
    expect(all.tabCounts?.purchased).toBeUndefined();
    // 采购方式不再是下拉筛选
    const def = (await import('@kudesi/shared')).getResourceDef('finance-products')!;
    expect(def.filterBy).toEqual(['categoryId']);
    void raw;
  });

  it('每个页签只显示自己的分类树（分类树不共用）', async () => {
    const treeIds = async (tab: string) => (await svc.categoryTree(boss, 'finance-products', 'categoryId', { tab })).nodes.map((n) => n.id);
    const orig = await treeIds('original_purchase');
    expect(orig).toContain(ids.origCat);
    expect(orig).not.toContain(ids.oemCat);
    const oem = await treeIds('supplier_oem');
    expect(oem).toContain(ids.oemCat);
    expect(oem).not.toContain(ids.origCat);
    expect(oem).not.toContain(ids.rawCat);
    const both = await treeIds('purchased');
    expect(both).toEqual(expect.arrayContaining([ids.origCat, ids.oemCat]));
    // 目录里的商品数也只算本页签：原装树下 2 个，OEM 树下 1 个
    const count = async (tab: string, id: number) => (await svc.categoryTree(boss, 'finance-products', 'categoryId', { tab })).nodes.find((n) => n.id === id)!.count;
    expect(await count('original_purchase', ids.origCat)).toBe(2);
    expect(await count('supplier_oem', ids.oemCat)).toBe(1);
  });

  it('商品必须挂在和自己采购方式一致的分类树上', async () => {
    await expect(mk({ name: '错树商品', supplyMode: 'supplier_oem', categoryId: ids.origCat, oemPackageWeightG: 1 })).rejects.toThrow(/不匹配/);
    await expect(mk({ name: '错树商品2', supplyMode: 'original_purchase', categoryId: ids.oemCat })).rejects.toThrow(/不匹配/);
  });
});
