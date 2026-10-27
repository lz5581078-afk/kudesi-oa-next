/** 对外只读接口：两种密钥用途互不通用；商品与成本目录按 afterId 翻页，只给已验证的组合。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { CatalogApiService } from './catalog-api.service';
import { CostService } from './cost.service';
import { CATALOG_SCOPE, DataToolsService } from './data-tools.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('商品与成本目录接口（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let tools: DataToolsService;
  let catalog: CatalogApiService;
  let boss: AuthUser;
  const bundleIds: number[] = [];

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const cost = new CostService(ds);
    tools = new DataToolsService(ds, cost);
    catalog = new CatalogApiService(ds, cost);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `k${crypto.randomBytes(5).toString('hex')}`, name: '目录测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const root = await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' });
    const leaf = await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: root.id });
    const plat = await svc.create(boss, 'finance-platforms', { code: 'TB', name: '淘宝' });
    const scen = await svc.create(boss, 'finance-scenarios', { code: 'std', name: '标准' });
    await svc.create(boss, 'finance-margins', { profitPercent: 20, reason: '默认' });
    for (const name of ['苹果', '香梨', '橙子']) {
      const p = await svc.create(boss, 'finance-products', { archiveType: 'raw', name, categoryId: leaf.id, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' });
      const bc = await svc.create(boss, 'finance-base-codes', { productId: p.id });
      await svc.changeStatus(boss, 'finance-base-codes', bc.id, 'verified');
      const b = await svc.create(boss, 'finance-bundles', { platformId: plat.id, scenarioId: scen.id, configNo: `0${bundleIds.length + 1}`, bundleCategoryId: (await svc.list(boss, 'finance-categories', { pageSize: 200 } as never)).items.find((c) => c.data.archiveType === 'bundle')?.id ?? (await svc.create(boss, 'finance-categories', { archiveType: 'bundle', name: '组合', code: 'ZH' })).id });
      await svc.create(boss, 'finance-bundle-lines', { bundleId: b.id, role: 'main', baseCodeId: bc.id, qty: 1 });
      if (name !== '橙子') await svc.changeStatus(boss, 'finance-bundles', b.id, 'verified');
      bundleIds.push(b.id);
    }
  });
  afterAll(async () => { await ds?.destroy(); });

  it('两种密钥用途互不通用，用途不认识就拒绝', async () => {
    const feedKey = await tools.createKey(boss, '看已验证组合');
    const catKey = await tools.createKey(boss, '看目录', CATALOG_SCOPE);
    expect(feedKey.scope).toBe('verified_bundle_read');
    expect(catKey.scope).toBe(CATALOG_SCOPE);
    await expect(tools.createKey(boss, 'x', 'write_everything')).rejects.toThrow(/用途/);
    expect(await tools.authenticateKey(catKey.key, CATALOG_SCOPE)).toBe(boss.companyId);
    await expect(tools.authenticateKey(catKey.key)).rejects.toThrow(/无效/);
    await expect(tools.authenticateKey(feedKey.key, CATALOG_SCOPE)).rejects.toThrow(/无效/);
    expect(await tools.authenticateKey(feedKey.key)).toBe(boss.companyId);
  });

  it('目录：只给已验证的组合，id 升序、afterId 翻页、每页上限 100', async () => {
    const all = await catalog.skuCosts(boss.companyId, {});
    expect(all.apiVersion).toBe('1');
    expect(all.companyId).toBe(boss.companyId);
    expect(all.items.map((i) => i.id)).toEqual(bundleIds.slice(0, 2));
    expect(all.items[0]).toMatchObject({ preShipCostCents: 1000, marginPercent: 20 });
    const p1 = await catalog.skuCosts(boss.companyId, { limit: 1 });
    expect(p1.hasMore).toBe(true);
    const p2 = await catalog.skuCosts(boss.companyId, { limit: 1, afterId: p1.nextAfterId });
    expect(p2.items[0].id).toBe(bundleIds[1]);
    expect(p2.hasMore).toBe(false);
    const one = await catalog.bundleCodes(boss.companyId, { code: all.items[1].code });
    expect(one.items).toHaveLength(1);
    expect(one.items[0]).toMatchObject({ platformCode: 'TB' });
    const cats = await catalog.bundleCategories(boss.companyId, {});
    expect(cats.items.map((c) => c.name).sort()).toEqual(['组合']); // 组合自己的分类树（不是主商品的分类）
    expect(cats.items.find((c) => c.name === '组合')?.bundleCount).toBe(2);
    expect((await catalog.costCategories(boss.companyId, {})).items.length).toBeGreaterThan(0);
  });
});
