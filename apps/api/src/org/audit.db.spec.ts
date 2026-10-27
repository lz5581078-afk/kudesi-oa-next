/** 审计日志与银行卡资金概况（真实数据库）。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { AuditController, BankFundController } from './audit.controller';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('审计日志与资金概况', () => {
  let ds: DataSource;
  let boss: AuthUser;
  let svc: ReturnType<typeof buildServices>['resources'];

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `a${crypto.randomBytes(5).toString('hex')}`, name: '审计', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds.destroy(); });

  it('资金概况按类型汇总，停用账户不计入合计', async () => {
    await svc.create(boss, 'bank-accounts', { kind: 'company_public', accountName: '公户A', bank: '测试银行', accountNo: '6200000000000001', balance: 100000 });
    await svc.create(boss, 'bank-accounts', { kind: 'company_public', accountName: '公户B', bank: '测试银行', accountNo: '6200000000000002', balance: 50000 });
    const off = await svc.create(boss, 'bank-accounts', { kind: 'company_card', accountName: '卡C', bank: '测试银行', accountNo: '6200000000000003', balance: 9900 });
    await svc.changeStatus(boss, 'bank-accounts', off.id, 'inactive', '不用了');
    const r = await new BankFundController(ds, buildServices(ds).crypto).summary(boss);
    expect(r.kinds.find((k) => k.kind === 'company_public')!.balanceCents).toBe(150000);
    expect(r.kinds.find((k) => k.kind === 'company_card')!.count).toBe(1);
    expect(r.kinds.find((k) => k.kind === 'company_card')!.balanceCents).toBe(0);
    expect(r.companyCents).toBe(150000);
    expect(r.storeCents).toBe(0);
    expect(r.totalCents).toBe(150000);
  });

  it('审计日志能看到资料变更，且按来源和关键词过滤', async () => {
    const ctl = new AuditController(ds);
    await svc.create(boss, 'bank-accounts', { kind: 'cashier_account', accountName: '出纳', bank: '测试银行', accountNo: '6200000000000009' });
    const all = await ctl.list(boss, 'resource', undefined, undefined, '1');
    expect(all.total).toBeGreaterThan(0);
    expect(all.items.every((i: { source: string }) => i.source === 'resource')).toBe(true);
    const none = await ctl.list(boss, undefined, '不存在的关键词xyz', undefined, '1');
    expect(none.total).toBe(0);
    // 时间范围：今天在范围内，遥远的过去不在；格式不对的日期被忽略
    const today = new Date().toISOString().slice(0, 10);
    const inRange = await ctl.list(boss, 'resource', undefined, undefined, '1', '2000-01-01', '2999-12-31');
    expect(inRange.total).toBe(all.total);
    expect((await ctl.list(boss, 'resource', undefined, undefined, '1', '2000-01-01', '2000-01-02')).total).toBe(0);
    expect((await ctl.list(boss, 'resource', undefined, undefined, '1', 'bad', undefined)).total).toBe(all.total);
    expect(today).toMatch(/^\d{4}-/);
  });
});
