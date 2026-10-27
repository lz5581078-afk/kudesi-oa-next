/** 仓库角色模式：精简列、没有日志/关联、成本价格脱敏、只能加照片 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Position, ResourceFile, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('仓库角色模式（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let wh: AuthUser;
  let plain: AuthUser;
  let productId: number;

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `w${crypto.randomBytes(5).toString('hex')}`, name: '仓库模式测试', status: 'active' }));
    const pos = await ds.manager.save(Position, ds.manager.create(Position, { companyId: c.id, name: '仓库专员', workspaceType: 'warehouse' }));
    const mk = (account: string, positionId: number | null, admin = false) =>
      ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account, passwordHash: 'x', name: account, isCompanyAdmin: admin, positionId, status: 'active', mustChangePassword: false }));
    const bu = await mk('boss', null, true);
    const wu = await mk('wh', pos.id);
    const pu = await mk('plain', null);
    boss = { id: bu.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    // 仓库专员：只读商品档案，另外被单独授予成本查看（成本仍应因为精简列而不出现）
    wh = { id: wu.id, companyId: c.id, name: '仓库', permissions: { isCompanyAdmin: false, allow: ['resource.finance-products.view'], deny: [] } };
    plain = { id: pu.id, companyId: c.id, name: '普通', permissions: { isCompanyAdmin: false, allow: ['resource.finance-products.view'], deny: [] } };
    const root = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' })).id;
    const leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: root })).id;
    productId = (await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '仓库苹果', categoryId: leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 100, handlingFee: 50, note: '内部备注', giftShortName: '苹' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('仓库岗位只看到精简列，没有备注、供应商、赠品简称、价格', async () => {
    const r = await svc.get(wh, 'finance-products', productId);
    expect(r.warehouseMode).toBe(true);
    expect(r.data.name).toBe('仓库苹果');
    expect(r.data.basicInfoFullName).toBeTruthy();
    for (const k of ['note', 'purchasePrice', 'freight', 'totalCost', 'giftShortName', 'zeroValueReason', 'supplierId']) expect(r.data).not.toHaveProperty(k);
    const list = await svc.list(wh, 'finance-products', {} as never);
    expect(list.items[0].warehouseMode).toBe(true);
    expect(list.items[0].data).not.toHaveProperty('note');
  });

  it('非仓库岗位的只读人员不受影响（仍按字段权限脱敏成本）；老板完整', async () => {
    const r = await svc.get(plain, 'finance-products', productId);
    expect(r.warehouseMode).toBeUndefined();
    expect(r.data.note).toBe('内部备注');
    expect(r.data).not.toHaveProperty('purchasePrice');
    expect((await svc.get(boss, 'finance-products', productId)).data.purchasePrice).toBe(1000);
  });

  it('仓库岗位看不到操作记录和关联', async () => {
    expect(await svc.logs(wh, 'finance-products', productId)).toEqual([]);
    expect((await svc.logs(boss, 'finance-products', productId)).length).toBeGreaterThan(0);
    expect(await svc.relations(wh, 'finance-products', productId, () => true)).toEqual([]);
  });

  it('仓库岗位只能追加照片；其他人不能用这个入口', async () => {
    const f = await ds.manager.save(ResourceFile, ds.manager.create(ResourceFile, { companyId: wh.companyId, resourceType: 'finance-products', resourceId: null, fieldKey: 'photos', storageKey: 'local:t/1.png', name: '1.png', mime: 'image/png', size: 10, uploadedBy: wh.id }));
    const r = await svc.addWarehousePhotos(wh, productId, [f.id]);
    expect(r.data.photos).toEqual([f.id]);
    const f2 = await ds.manager.save(ResourceFile, ds.manager.create(ResourceFile, { companyId: wh.companyId, resourceType: 'finance-products', resourceId: null, fieldKey: 'photos', storageKey: 'local:t/2.png', name: '2.png', mime: 'image/png', size: 10, uploadedBy: wh.id }));
    expect((await svc.addWarehousePhotos(wh, productId, [f2.id])).data.photos).toEqual([f.id, f2.id]);
    await expect(svc.addWarehousePhotos(plain, productId, [])).rejects.toThrow(/仓库岗位/);
    await expect(svc.addWarehousePhotos(wh, productId, [999999])).rejects.toThrow(/无效的文件/);
  });
});
