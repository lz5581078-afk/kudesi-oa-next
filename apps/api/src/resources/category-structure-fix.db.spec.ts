import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { applyCategoryFix, planCategoryFix } from './category-structure-fix';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('迁入后分类结构修正（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `x${crypto.randomBytes(5).toString('hex')}`, name: '修正测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `fx${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('OEM 分类树改为独立；被压成一个名字的第 4 级拆回来，原记录（和引用它的资料）不变', async () => {
    // 旧迁入的样子：OEM 树混在 package 下
    const oemRoot = await svc.create(boss, 'finance-categories', { archiveType: 'package', name: '修正OEM根', code: 'XO1' });
    const oemLeaf = await svc.create(boss, 'finance-categories', { archiveType: 'package', name: '修正OEM叶', code: 'XO2', parentId: oemRoot.id });
    const pkRoot = await svc.create(boss, 'finance-categories', { archiveType: 'package', name: '修正包装根', code: 'XP1' });
    const brand = await svc.create(boss, 'finance-brands', { name: '修正品牌' });
    const mk = (cat: number, type: string, name: string) => svc.create(boss, 'finance-products', { archiveType: type, name, capacities: '1KG', purchaseSpec: '个', specQty: 1, specUnit: 'EA', purchasePrice: 10, freight: 1, handlingFee: 1, brandId: brand.id, categoryId: cat });
    await mk(oemLeaf.id, 'package', '临时产品包装');
    // 模拟旧数据：把这个商品直接改成 oem_package（绕过类型校验，等同迁入时的状态）
    const prod = await ds.manager.findOneByOrFail(ResourceRecord, { companyId: boss.companyId, type: 'finance-products', title: '临时产品包装' });
    prod.data = { ...prod.data, archiveType: 'oem_package' };
    await ds.manager.save(prod);
    await mk(pkRoot.id, 'package', '正常产品包装');

    const s1 = await svc.create(boss, 'finance-supplier-categories', { name: '甲' });
    const s2 = await svc.create(boss, 'finance-supplier-categories', { name: '乙', parentId: s1.id });
    const flat = await svc.create(boss, 'finance-supplier-categories', { name: '丙 / 丁', parentId: s2.id });

    const plan = await planCategoryFix(ds.manager, boss.companyId);
    expect(plan.oem.find((x) => x.rootId === oemRoot.id)?.decision).toBe('move');
    expect(plan.oem.find((x) => x.rootId === pkRoot.id)?.decision).toBe('keep');
    expect(plan.split.map((x) => x.id)).toEqual([flat.id]);

    const done = await applyCategoryFix(ds, svc, boss, plan);
    expect(done).toEqual({ oemMoved: 2, split: 1 });
    expect((await svc.get(boss, 'finance-categories', oemLeaf.id)).data.archiveType).toBe('oem_package');
    expect((await svc.get(boss, 'finance-categories', pkRoot.id)).data.archiveType).toBe('package');
    const fixed = await svc.get(boss, 'finance-supplier-categories', flat.id);
    expect(fixed.title).toBe('丁');
    expect(fixed.refLabels.parentId).toBe('甲 / 乙 / 丙');
    // 再跑一次没有可改的
    const again = await planCategoryFix(ds.manager, boss.companyId);
    expect(again.split).toHaveLength(0);
    expect(again.oem.every((x) => x.decision !== 'move' || x.rootId !== oemRoot.id)).toBe(true);
  });
});
