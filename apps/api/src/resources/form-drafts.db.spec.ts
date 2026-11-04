import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User, FormDraft } from '../entities';
import { CryptoService } from '../common/crypto.service';
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
    svc = new FormDraftsService(ds, new CryptoService({ test: crypto.randomBytes(32) }, 'test'));
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

  it('供应商收款账号草稿在库中加密，本人重开完整恢复；撤销新增权限后不能再读取', async () => {
    const user = { ...a, permissions: { isCompanyAdmin: false, allow: ['resource.finance-suppliers.create'], deny: [] } };
    const draftKey = 'resource%3Afinance-suppliers:_';
    const payload = { name: '草稿供应商', bankAccountNo: '6222000012345678', __archiveState: { manualCode: true } };
    await svc.put(user, draftKey, { moduleKey: 'resource:finance-suppliers', payload });
    const raw = await ds.manager.findOneByOrFail(FormDraft, { companyId: user.companyId, userId: user.id, draftKey });
    expect(JSON.stringify(raw.payload)).not.toContain(payload.bankAccountNo);
    expect(raw.payload.__encryptedDraft).toMatch(/^v1:/);
    expect((await svc.get(user, draftKey)).draft?.payload).toEqual(payload);
    await expect(svc.get({ ...user, permissions: noCreate.permissions }, draftKey)).rejects.toThrow(/权限/);
  });

  it('商品草稿重新读取时按当前成本权限过滤主表和供货来源价格', async () => {
    const admin = { ...a, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    await svc.put(admin, key, { moduleKey: 'resource:finance-products', payload: { name: '草稿原料', purchasePrice: 150, __productParts: { sources: [{ supplierId: 2, originArea: '山东', purchasePrice: 150 }] } } });
    const draft = (await svc.get(a, key)).draft!.payload;
    expect(draft.name).toBe('草稿原料');
    expect(draft.purchasePrice).toBeUndefined();
    expect(JSON.stringify(draft.__productParts)).not.toContain('purchasePrice');
  });

  it('人工版本/项目草稿继承资料新增权限，按版本隔离并加密零值确认，撤销成本权限后确认也隐藏', async () => {
    const owner = { ...a, permissions: { isCompanyAdmin: false, allow: ['resource.finance-labor-costs.create', 'product.cost.view', 'product.cost.edit'], deny: [] } };
    const versionKey = 'resource%3Afinance-labor-versions:_:_';
    await svc.put(owner, versionKey, { moduleKey: 'resource:finance-labor-versions', payload: { versionCode: 'RL-DRAFT', versionName: '合成版本草稿' } });
    expect((await svc.get(owner, versionKey)).draft!.payload.versionName).toBe('合成版本草稿');
    const first = 'resource%3Afinance-labor-costs:10', second = 'resource%3Afinance-labor-costs:20';
    const payload = { versionId: 10, workName: '合成项目草稿', unitPrice: 0, zeroReason: '合成优惠原因', zeroCostConfirmation: { reason: '合成优惠原因', context: '["合成项目草稿","件","包装"]' }, __draftStatus: 'inactive' };
    await svc.put(owner, first, { moduleKey: 'resource:finance-labor-costs', sourceRecordId: '91', payload });
    const draft = (await svc.get(owner, first)).draft!;
    expect(draft.payload).toEqual(payload); expect(draft.sourceRecordId).toBe('91');
    expect((await svc.get(owner, second)).draft).toBeNull();
    const raw = await ds.manager.findOneByOrFail(FormDraft, { companyId: owner.companyId, userId: owner.id, draftKey: first });
    expect(JSON.stringify(raw.payload)).not.toContain('合成优惠原因'); expect(raw.payload.__encryptedDraft).toMatch(/^v1:/);
    const hidden = (await svc.get({ ...owner, permissions: { ...owner.permissions, allow: ['resource.finance-labor-costs.create'] } }, first)).draft!.payload;
    expect(hidden.workName).toBe(payload.workName); expect(hidden.unitPrice).toBeUndefined(); expect(hidden.zeroReason).toBeUndefined(); expect(hidden.zeroCostConfirmation).toBeUndefined();
    await expect(svc.get({ ...owner, permissions: { ...owner.permissions, allow: [] } }, first)).rejects.toThrow(/新增/);
  });
});
