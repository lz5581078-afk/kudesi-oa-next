/** 组合装出站：完整内容、子商品依赖检查、回读确认、结果未知不重发、账号核对、归档/修订守卫。全程用假发送器，不连聚水潭。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from '../resources/resources.service';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { OutboxService } from './outbox.service';
import { FakeJstSender } from './fake-jst-sender';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('组合装出站（真实数据库 + 假发送器）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let outbox: OutboxService;
  let tools: BundleToolsService;
  let boss: AuthUser;
  const fake = new FakeJstSender();
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    svc = s.resources;
    outbox = new OutboxService(ds, svc);
    tools = new BundleToolsService(ds, svc, outbox);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `b${crypto.randomBytes(5).toString('hex')}`, name: '组合出站', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const root = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' })).id;
    const leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: root })).id;
    const p = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '苹果', categoryId: leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' });
    const bc = await svc.create(boss, 'finance-base-codes', { productId: p.id, code: 'APPLE-A', codeChangeReason: '测试' });
    await svc.changeStatus(boss, 'finance-base-codes', bc.id, 'verified');
    ids.bc = bc.id;
    const plat = await svc.create(boss, 'finance-platforms', { code: 'TB', name: '淘宝' });
    const scen = await svc.create(boss, 'finance-scenarios', { code: 'standard', name: '标准', segment: '' });
    const bcat = await svc.create(boss, 'finance-categories', { archiveType: 'bundle', name: '水果组合', code: 'SGZH' });
    const made = await tools.generate(boss, [{ role: 'main', baseCodeId: bc.id, qty: 2 }], [{ platformId: plat.id, scenarioId: scen.id, bundleCategoryId: bcat.id }]);
    ids.bundle = made.created[0].id;
    await svc.changeStatus(boss, 'finance-bundles', ids.bundle, 'verified');
    await outbox.setSwitch(boss, true, '测试');
    outbox.setSender(fake);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('子商品还没上传到聚水潭：指定上传报错并写进同步说明，不入队', async () => {
    await expect(outbox.enqueue(boss, 'finance-bundles', [ids.bundle])).rejects.toThrow(/还没有上传/);
    expect(String((await svc.get(boss, 'finance-bundles', ids.bundle)).data.jstMessage)).toContain('APPLE-A');
    expect((await outbox.enqueue(boss, 'finance-bundles')).queued).toBe(0);
  });

  it('子商品上传后：内容完整（款式编码、规格值、子商品列表），回读一致才算成功', async () => {
    await outbox.enqueue(boss, 'finance-base-codes', [ids.bc]);
    expect((await outbox.processCompany(boss.companyId)).sent).toBe(1);
    expect((await outbox.enqueue(boss, 'finance-bundles', [ids.bundle])).queued).toBe(1);
    expect((await outbox.processCompany(boss.companyId)).sent).toBe(1);
    const job = fake.sent[fake.sent.length - 1];
    expect(job.payload).toMatchObject({ childList: [{ src_sku_id: 'APPLE-A', qty: 2 }] });
    expect(String(job.payload.i_id)).not.toBe('');
    expect(String(job.payload.properties_value)).not.toBe('');
    expect((await svc.get(boss, 'finance-bundles', ids.bundle)).data.jstStatus).toBe('synced');
  });

  it('归档守卫：有待发送任务或待发布修订时不能归档', async () => {
    await svc.update(boss, 'finance-bundles', ids.bundle, { manualShortName: '新简称', manualReason: '测试' });
    await svc.changeStatus(boss, 'finance-bundles', ids.bundle, 'verified');
    expect((await outbox.enqueue(boss, 'finance-bundles', [ids.bundle])).queued).toBe(1);
    await expect(tools.archive(boss, ids.bundle, '不用了', true)).rejects.toThrow(/没发送完/);
  });

  it('回读对不上：标记失败、结果未知，不会自动重发', async () => {
    const before = fake.sent.length;
    await outbox.processCompany(boss.companyId);
    await svc.update(boss, 'finance-bundles', ids.bundle, { manualShortName: '再改一次', manualReason: '测试' });
    await svc.changeStatus(boss, 'finance-bundles', ids.bundle, 'verified');
    fake.readMode = 'mismatch';
    {
      expect((await outbox.enqueue(boss, 'finance-bundles', [ids.bundle])).queued).toBe(1);
      const r = await outbox.processCompany(boss.companyId);
      expect(r.failed).toBe(1);
      expect(fake.sent.length).toBeGreaterThan(before);
      expect(String((await svc.get(boss, 'finance-bundles', ids.bundle)).data.jstMessage)).toContain('结果未知');
      const again = fake.sent.length;
      await outbox.processCompany(boss.companyId);
      expect(fake.sent.length).toBe(again); // 不重发
    }
    fake.readMode = 'ok';
  });

  it('账号核对：入队时的账号和现在连接的不一致，任务取消、不发送', async () => {
    fake.targetKey = 'shop-A';
    await ds.query("UPDATE outbox_jobs SET status = 'cancelled' WHERE company_id = ? AND status IN ('pending','failed')", [boss.companyId]);
    await outbox.enqueue(boss, 'finance-base-codes', [ids.bc]).catch(() => undefined);
    await ds.query("UPDATE outbox_jobs SET payload_json = JSON_SET(payload_json, '$.targetKey', 'shop-B'), status = 'pending' WHERE company_id = ? AND resource_type = 'finance-base-codes' ORDER BY id DESC LIMIT 1", [boss.companyId]);
    const n = fake.sent.length;
    await outbox.processCompany(boss.companyId);
    expect(fake.sent.length).toBe(n);
    fake.targetKey = undefined;
  });
});
