import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { FormDraftsService } from './form-drafts.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('表单草稿（真实数据库）', () => {
  let ds: DataSource;
  let svc: FormDraftsService;
  let a: AuthUser, a2: AuthUser, other: AuthUser, noCreate: AuthUser;
  const key = 'resource%3Afinance-products:raw:';
  const mk = async (companyId: number, account: string, perm: string[]): Promise<AuthUser> => {
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name: account, status: 'active', mustChangePassword: false }));
    return { id: u.id, companyId, name: account, permissions: { isCompanyAdmin: false, allow: perm, deny: [] } };
  };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = new FormDraftsService(ds);
    const c1 = await ds.manager.save(Company, ds.manager.create(Company, { code: `d${crypto.randomBytes(5).toString('hex')}`, name: '草稿一', status: 'active' }));
    const c2 = await ds.manager.save(Company, ds.manager.create(Company, { code: `d${crypto.randomBytes(5).toString('hex')}`, name: '草稿二', status: 'active' }));
    a = await mk(c1.id, 'a', ['resource.finance-products.create']);
    a2 = await mk(c1.id, 'a2', ['resource.finance-products.create']);
    noCreate = await mk(c1.id, 'nc', ['resource.finance-products.view']);
    other = await mk(c2.id, 'o', ['resource.finance-products.create']);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('存、取、覆盖、删除；草稿只属于本人，换人、换公司都看不到', async () => {
    expect((await svc.get(a, key)).draft).toBeNull();
    await svc.put(a, key, { moduleKey: 'resource:finance-products', title: '新增商品档案', payload: { name: '半成品', specQty: 2 } });
    expect((await svc.get(a, key)).draft?.payload).toEqual({ name: '半成品', specQty: 2 });
    await svc.put(a, key, { moduleKey: 'resource:finance-products', payload: { name: '改过' } });
    expect((await svc.get(a, key)).draft?.payload).toEqual({ name: '改过' });
    expect((await svc.get(a2, key)).draft).toBeNull();
    expect((await svc.get(other, key)).draft).toBeNull();
    await svc.remove(a2, key); // 删别人的等于没删
    expect((await svc.get(a, key)).draft).not.toBeNull();
    await svc.remove(a, key);
    expect((await svc.get(a, key)).draft).toBeNull();
  });

  it('只能给有新增权限的资料存草稿；标识、模块、大小都要合法', async () => {
    const ok = { moduleKey: 'resource:finance-products', payload: { name: 'x' } };
    await expect(svc.put(noCreate, key, ok)).rejects.toThrow(/没有新增/);
    await expect(svc.put(a, key, { ...ok, moduleKey: 'resource:no-such' })).rejects.toThrow(/不存在/);
    await expect(svc.put(a, key, { ...ok, moduleKey: 'finance-products' })).rejects.toThrow(/不合法/);
    await expect(svc.put(a, 'resource%3Astores:x', ok)).rejects.toThrow(/不一致/);
    await expect(svc.put(a, 'a b/c', ok)).rejects.toThrow(/标识/);
    await expect(svc.put(a, key, { ...ok, payload: { big: 'x'.repeat(300 * 1024) } })).rejects.toThrow(/太大/);
  });
});
