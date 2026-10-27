/** 基础编码验证事件历史：每次验证通过追加一行，历史里带和上次相比的改动；有历史的编码不能直接删除 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ProductVerificationEvent, User } from '../entities';
import { OutboxService } from '../outbox/outbox.service';
import { buildServices } from '../test-support';
import { BaseCodeToolsService } from './base-code-tools.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('基础编码验证事件历史（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let bc: BaseCodeToolsService;
  let boss: AuthUser;
  let noCost: AuthUser;
  let productId: number;
  let codeId: number;

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    bc = new BaseCodeToolsService(ds, svc, new OutboxService(ds, svc));
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `v${crypto.randomBytes(5).toString('hex')}`, name: '验证历史测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    noCost = { id: u.id, companyId: c.id, name: '运营', permissions: { isCompanyAdmin: false, allow: ['resource.finance-base-codes.*'], deny: [] } };
    const root = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' })).id;
    const leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: root })).id;
    productId = (await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '历史苹果', categoryId: leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 100, handlingFee: 50 })).id;
    codeId = (await svc.list(boss, 'finance-base-codes', { fieldKey: 'productId', fieldValue: productId } as never)).items[0].id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('验证通过追加事件；档案变了二次验证再追加一条并带差异', async () => {
    const rep = await bc.report(boss, codeId);
    expect(rep.issueCount).toBe(0);
    await bc.verify(boss, [{ id: codeId, signature: rep.signature }], { confirmed: true, syncToJst: false });
    expect(await ds.manager.count(ProductVerificationEvent, { where: { companyId: boss.companyId, baseCodeId: codeId } })).toBe(1);
    // 档案成本变了 -> 重新验证
    await svc.update(boss, 'finance-products', productId, { purchasePrice: 1200 });
    expect((await svc.get(boss, 'finance-base-codes', codeId)).status).toBe('reverify');
    const rep2 = await bc.report(boss, codeId);
    await bc.verify(boss, [{ id: codeId, signature: rep2.signature }], { confirmed: true, syncToJst: false });
    expect(await ds.manager.count(ProductVerificationEvent, { where: { companyId: boss.companyId, baseCodeId: codeId } })).toBe(2);
    const h = await bc.verificationHistory(boss, codeId);
    expect(h.rows).toHaveLength(2);
    expect(h.rows[0].first).toBe(false);
    expect(h.rows[1].first).toBe(true);
    expect(h.rows[0].changes.length).toBeGreaterThan(0);
    expect(h.rows[0].verifiedBy).toBe('老板');
    // 没有成本查看权限的人，差异里不带成本
    const h2 = await bc.verificationHistory(noCost, codeId);
    expect(JSON.stringify(h2.rows[0].changes)).not.toMatch(/1200|1000/);
  });

  it('有验证历史的编码不能按“未验证”直接删除', async () => {
    const p = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '另一个苹果', categoryId: (await svc.get(boss, 'finance-products', productId)).data.categoryId as number, purchaseSpec: '千克', specQty: 2, specUnit: 'KG', purchasePrice: 1000, freight: 100, handlingFee: 50 });
    const id = (await svc.list(boss, 'finance-base-codes', { fieldKey: 'productId', fieldValue: p.id } as never)).items[0].id;
    await ds.manager.insert(ProductVerificationEvent, { companyId: boss.companyId, baseCodeId: id, compositionSignature: 'x', verifiedBy: boss.id, snapshotJson: null });
    const pre = await bc.deletionPreview(boss, 'pending', [id]);
    expect(pre.groups[0].canDelete).toBe(false);
    expect(pre.groups[0].reason).toMatch(/验证历史/);
  });
});
