/** 分类拖拽排序、改命名规则后按新规则批量重生成编码（预览→写原因→确认）。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { OutboxService } from '../outbox/outbox.service';
import { BundleToolsService } from './bundle-tools.service';
import { CategoryToolsService } from './category-tools.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('分类排序与批量重生成编码（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let tools: BundleToolsService;
  let cats: CategoryToolsService;
  let boss: AuthUser;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    svc = s.resources;
    tools = new BundleToolsService(ds, svc, new OutboxService(ds, svc));
    cats = new CategoryToolsService(ds, svc);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `r${crypto.randomBytes(5).toString('hex')}`, name: '重生成', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    ids.root = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' })).id;
    const leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: ids.root })).id;
    const p = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '苹果', categoryId: leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' });
    const bc = await svc.create(boss, 'finance-base-codes', { productId: p.id, code: 'APPLE-A', codeChangeReason: '测试' });
    await svc.changeStatus(boss, 'finance-base-codes', bc.id, 'verified');
    ids.bc = bc.id;
    ids.scen = (await svc.create(boss, 'finance-scenarios', { code: 'standard', name: '标准', segment: '' })).id;
    ids.bcat = (await svc.create(boss, 'finance-categories', { archiveType: 'bundle', name: '水果组合', code: 'SGZH' })).id;
    ids.leaf = leaf;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('拖拽排序：同一上级下重排，只改顺序；跨上级、跨树、重复都拒绝；被隐藏的兄弟不动', async () => {
    const a = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: 'A类', code: 'AA', parentId: ids.root })).id;
    const b = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: 'B类', code: 'BB', parentId: ids.root })).id;
    const c = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: 'C类', code: 'CC', parentId: ids.root })).id;
    const sortOf = async (id: number) => Number((await svc.get(boss, 'finance-categories', id)).data.sort ?? 0);
    const order = async () => (await Promise.all([ids.leaf, a, b, c].map(async (id) => ({ id, s: await sortOf(id) })))).sort((x, y) => x.s - y.s || x.id - y.id).map((x) => x.id);
    await cats.reorder(boss, [c, b, a]);
    expect((await order()).slice(-3)).toEqual([c, b, a]);
    // 只传两个：它们占住原来的位置，没传的苹果类不动
    const before = await order();
    await cats.reorder(boss, [a, c]);
    const after = await order();
    expect(after.indexOf(a)).toBeLessThan(after.indexOf(c));
    expect(after.indexOf(ids.leaf)).toBe(before.indexOf(ids.leaf));
    await expect(cats.reorder(boss, [a, ids.root])).rejects.toThrow(/同一个上级/);
    await expect(cats.reorder(boss, [a, ids.bcat])).rejects.toThrow(/同一个上级/);
    await expect(cats.reorder(boss, [a, a])).rejects.toThrow(/重复/);
    await expect(cats.reorder(boss, [a, 99999999])).rejects.toThrow(/不存在/);
    // 分类目录接口按新顺序给出
    const tree = await cats.tree(boss, 'raw');
    const kids = tree.nodes.filter((n) => n.parentId === ids.root).map((n) => n.id);
    expect(kids.indexOf(a)).toBeLessThan(kids.indexOf(c));
  });

  it('改了命名规则：预览列出新旧编码；必须写原因并确认；预览后规则又变了拒绝；已验证的变成需重新验证', async () => {
    const made = await tools.generate(boss, [{ role: 'main', baseCodeId: ids.bc, qty: 2 }], []).catch(() => null);
    expect(made).toBeNull(); // 没有目标不能生成
    const plat = await svc.create(boss, 'finance-platforms', { code: 'TB', name: '淘宝' });
    const gen = await tools.generate(boss, [{ role: 'main', baseCodeId: ids.bc, qty: 2 }], [{ platformId: plat.id, scenarioId: ids.scen, bundleCategoryId: ids.bcat }]);
    const bundleId = gen.created[0].id;
    await svc.changeStatus(boss, 'finance-bundles', bundleId, 'verified');
    const oldCode = String((await svc.get(boss, 'finance-bundles', bundleId)).data.code);
    expect((await tools.regeneratePreview(boss)).rows).toHaveLength(0); // 规则没变，没有差异
    await svc.create(boss, 'finance-bundle-naming-rules', { categoryId: ids.root, prefix: 'QQ-', namePrefix: '套-', codeFields: 'category,platform,quantity', nameFields: 'name,quantity' });
    const pv = await tools.regeneratePreview(boss);
    expect(pv.rows).toHaveLength(1);
    expect(pv.rows[0]).toMatchObject({ id: bundleId, oldCode, blocked: null, error: null });
    expect(pv.rows[0].newCode.startsWith('QQ-')).toBe(true);
    // 预览不改任何东西
    expect(String((await svc.get(boss, 'finance-bundles', bundleId)).data.code)).toBe(oldCode);
    await expect(tools.regenerateExecute(boss, [{ id: bundleId, token: pv.rows[0].token }], '', true)).rejects.toThrow(/原因/);
    await expect(tools.regenerateExecute(boss, [{ id: bundleId, token: pv.rows[0].token }], '规则调整', false)).rejects.toThrow(/确认/);
    const stale = await tools.regenerateExecute(boss, [{ id: bundleId, token: 'old' }], '规则调整', true);
    expect(stale.results[0]).toMatchObject({ ok: false });
    const done = await tools.regenerateExecute(boss, [{ id: bundleId, token: pv.rows[0].token }], '规则调整', true);
    expect(done.done).toBe(1);
    const after = await svc.get(boss, 'finance-bundles', bundleId);
    expect(after.data.code).toBe(pv.rows[0].newCode);
    expect(after.status).toBe('reverify');
    expect((await tools.regeneratePreview(boss)).rows).toHaveLength(0);
  });
});
