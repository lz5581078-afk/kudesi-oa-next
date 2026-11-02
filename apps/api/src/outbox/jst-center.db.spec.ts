/** 聚水潭同步能力中心的实时概览（真实数据库）：只读；按公司隔离；队列统计与最近失败。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, OutboxJob, User } from '../entities';
import { buildServices } from '../test-support';
import { JstCenterController } from './jst-center.controller';
import { OutboxService } from './outbox.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('聚水潭同步能力中心（真实数据库）', () => {
  let ds: DataSource;
  let ctl: JstCenterController;
  const mk = async (name: string) => {
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `j${crypto.randomBytes(5).toString('hex')}`, name, status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'a', passwordHash: 'x', name: '管理员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    return { id: u.id, companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser;
  };
  const job = (companyId: number, status: OutboxJob['status'], kind: string, extra: Partial<OutboxJob> = {}) =>
    ds.manager.insert(OutboxJob, { companyId, channel: 'jushuitan', kind, resourceType: 'finance-bundles', resourceId: 1, idempotencyKey: crypto.randomBytes(8).toString('hex'), payloadJson: { secret: 'x' }, status, nextAttemptAt: new Date(), ...extra } as never);

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    ctl = new JstCenterController(new OutboxService(ds, buildServices(ds).resources), ds);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('新公司：总开关关、没有任务；有任务后按状态和类型统计，失败带原因，不带任务内容，别家公司看不到', async () => {
    const a = await mk('甲'), b = await mk('乙');
    const empty = await ctl.overview(a);
    expect(empty.switch.enabled).toBe(false);
    expect(empty.priceSwitch.enabled).toBe(false);
    expect(empty.senderConfigured).toBe(false);
    expect(empty.counts).toEqual({});
    await job(a.companyId, 'pending', 'bundle_upsert');
    await job(a.companyId, 'pending', 'bundle_upsert');
    await job(a.companyId, 'failed', 'bundle_price_update', { lastError: '还没有接入聚水潭接口', attempts: 5 });
    await job(b.companyId, 'done', 'bundle_upsert');
    const r = await ctl.overview(a);
    expect(r.counts).toEqual({ pending: 2, failed: 1 });
    expect(r.byKind.bundle_upsert).toEqual({ pending: 2 });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ kind: 'bundle_price_update', lastError: '还没有接入聚水潭接口', attempts: 5 });
    expect(JSON.stringify(r)).not.toContain('secret');
    expect((await ctl.overview(b)).counts).toEqual({ done: 1 });
  });
});
