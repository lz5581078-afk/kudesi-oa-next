/** 出站队列（聚水潭同步）的真实数据库测试：总开关默认关；只入队不发送；失败退避；中途关闸立刻停。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from '../resources/resources.service';
import { OutboxSender, OutboxService } from './outbox.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('聚水潭同步队列（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let outbox: OutboxService;
  let boss: AuthUser;
  let staff: AuthUser;
  const ids: Record<string, number> = {};
  const sentKeys: string[] = [];
  const sender = (over: Partial<OutboxSender> = {}): OutboxSender => ({ configured: true, send: async (j) => { sentKeys.push(j.idempotencyKey); }, ...over });

  const mkBc = async (name: string, code: string) => {
    const p = await svc.create(boss, 'finance-products', { archiveType: 'raw', name, categoryId: ids.leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' });
    return svc.create(boss, 'finance-base-codes', { productId: p.id, code, codeChangeReason: '测试' });
  };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    outbox = new OutboxService(ds, svc);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `o${crypto.randomBytes(5).toString('hex')}`, name: '队列测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    staff = { id: u.id, companyId: c.id, name: '员工', permissions: { isCompanyAdmin: false, allow: ['finance.jst-sync.view'], deny: [] } };
    const root = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' })).id;
    const leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: root })).id;
    ids.leaf = leaf;
    ids.bc = (await mkBc('苹果', 'APPLE-A')).id;
    ids.bc2 = (await mkBc('梨', 'APPLE-B')).id; // 不验证
    await svc.changeStatus(boss, 'finance-base-codes', ids.bc, 'verified');
  });
  afterAll(async () => { await ds?.destroy(); });

  it('总开关默认关；没验证的不能同步；入队只改状态不发送，同一版本不会重复入队', async () => {
    expect((await outbox.getSwitch(boss.companyId)).enabled).toBe(false);
    await expect(outbox.enqueue(staff, 'finance-base-codes')).rejects.toThrow(/管理员/);
    await expect(outbox.enqueue(boss, 'finance-products')).rejects.toThrow(/不支持/);
    await expect(outbox.enqueue(boss, 'finance-base-codes', [ids.bc2])).rejects.toThrow(/还没有验证/);
    expect(await outbox.enqueue(boss, 'finance-base-codes')).toEqual({ queued: 1, skipped: 0 });
    expect((await svc.get(boss, 'finance-base-codes', ids.bc)).data.jstStatus).toBe('pending');
    expect((await outbox.enqueue(boss, 'finance-base-codes', [ids.bc])).queued).toBe(0);
    const j = await outbox.jobs(boss, { page: 1, pageSize: 10 });
    expect(j.counts).toEqual({ pending: 1 });
    expect(j.rows[0].payload).toMatchObject({ code: 'APPLE-A' });
  });

  it('开关关着、或没有接入真实发送器：一条也不发', async () => {
    expect(await outbox.processCompany(boss.companyId)).toEqual({ sent: 0, failed: 0, blocked: true });
    await outbox.setSwitch(boss, true, '测试');
    expect(await outbox.processCompany(boss.companyId)).toEqual({ sent: 0, failed: 0, blocked: true }); // 默认发送器没配置
    expect(sentKeys).toHaveLength(0);
    await expect(outbox.setSwitch(staff, true)).rejects.toThrow(/管理员/);
  });

  it('开关打开且发送器就绪才发送；成功后标记已同步；失败退避重试，超过次数标记失败', async () => {
    outbox.setSender(sender());
    expect(await outbox.processCompany(boss.companyId)).toEqual({ sent: 1, failed: 0, blocked: false });
    expect(sentKeys).toHaveLength(1);
    expect((await svc.get(boss, 'finance-base-codes', ids.bc)).data.jstStatus).toBe('synced');
    // 再发一次改动：编码名称变了 → 新版本入队 → 发送失败
    expect((await outbox.enqueue(boss, 'finance-base-codes', [ids.bc])).queued).toBe(0); // 内容没变，不重复入队
    await svc.update(boss, 'finance-base-codes', ids.bc, { shortName: '改一下' });
    await svc.changeStatus(boss, 'finance-base-codes', ids.bc, 'verified').catch(() => undefined);
    expect((await outbox.enqueue(boss, 'finance-base-codes', [ids.bc])).queued).toBe(1);
    outbox.setSender(sender({ send: async () => { throw new Error('接口超时'); } }));
    expect(await outbox.processCompany(boss.companyId)).toEqual({ sent: 0, failed: 1, blocked: false });
    let job = (await outbox.jobs(boss, { status: 'pending', page: 1, pageSize: 5 })).rows[0];
    expect(job.attempts).toBe(1);
    expect(job.lastError).toBe('接口超时');
    expect(await outbox.processCompany(boss.companyId)).toEqual({ sent: 0, failed: 0, blocked: false }); // 退避中，不会马上再发
    for (let i = 0; i < 4; i++) {
      await ds.query("UPDATE outbox_jobs SET next_attempt_at = NOW() WHERE id = ?", [job.id]);
      await outbox.processCompany(boss.companyId);
    }
    const failed = await outbox.jobs(boss, { status: 'failed', page: 1, pageSize: 5 });
    expect(failed.total).toBe(1);
    expect((await svc.get(boss, 'finance-base-codes', ids.bc)).data.jstStatus).toBe('failed');
    await outbox.retry(boss, failed.rows[0].id);
    outbox.setSender(sender());
    expect((await outbox.processCompany(boss.companyId)).sent).toBe(1);
    expect((await svc.get(boss, 'finance-base-codes', ids.bc)).data.jstStatus).toBe('synced');
    job = (await outbox.jobs(boss, { status: 'done', page: 1, pageSize: 5 })).rows[0];
    expect(job.status).toBe('done');
  });

  it('一键停止：处理到一半被关掉，后面的不再发送；已取消的任务不会发', async () => {
    const bcs: number[] = [];
    for (const code of ['K-1', 'K-2', 'K-3']) {
      const b = await mkBc(`物料${code}`, code);
      await svc.changeStatus(boss, 'finance-base-codes', b.id, 'verified');
      bcs.push(b.id);
    }
    expect((await outbox.enqueue(boss, 'finance-base-codes', bcs)).queued).toBe(3);
    const jobs = (await outbox.jobs(boss, { status: 'pending', page: 1, pageSize: 10 })).rows;
    await outbox.cancel(boss, jobs[jobs.length - 1].id);
    const before = sentKeys.length;
    outbox.setSender(sender({ send: async (j) => { sentKeys.push(j.idempotencyKey); await outbox.setSwitch(boss, false, '一键停止'); } }));
    const r = await outbox.processCompany(boss.companyId);
    expect(sentKeys.length - before).toBe(1);
    expect(r.blocked).toBe(true);
    expect((await outbox.jobs(boss, { page: 1, pageSize: 10 })).counts).toMatchObject({ pending: 1, cancelled: 1 });
  });
  it('旧队列中超出聚水潭精度的单价直接停止，不自动重试或执行写入', async () => {
    const { assertJstNormalPricePrecision } = await import('./jst-price-precision');
    const pending = (await outbox.jobs(boss, { status: 'pending', page: 1, pageSize: 100 })).rows;
    for (const job of pending) await outbox.cancel(boss, job.id);
    const bc = await mkBc('精度测试', 'PRECISION-GUARD');
    const writes = jest.fn();
    outbox.setSender(sender({ send: async job => { assertJstNormalPricePrecision(job.payload); writes(); } }));
    await ds.query("INSERT INTO outbox_jobs(company_id,channel,kind,resource_type,resource_id,idempotency_key,payload_json,created_by) VALUES(?,'jushuitan','base_code_upsert','finance-base-codes',?,'precision-guard',?,?)", [boss.companyId, bc.id, JSON.stringify({ sku_id: 'PRECISION-GUARD', cost_price: 0.012345 }), boss.id]);
    await outbox.setSwitch(boss, true, '精度测试');
    expect(await outbox.processCompany(boss.companyId)).toMatchObject({ sent: 0, failed: 1 });
    const job = (await outbox.jobs(boss, { status: 'failed', page: 1, pageSize: 100 })).rows.find((j: { resourceId: number }) => j.resourceId === bc.id)!;
    expect(job).toMatchObject({ status: 'failed', attempts: 1 });
    expect(job.lastError).toMatch(/只保留元后 4 位/);
    expect(await outbox.processCompany(boss.companyId)).toMatchObject({ sent: 0, failed: 0 });
    expect(writes).not.toHaveBeenCalled();
  });

});
