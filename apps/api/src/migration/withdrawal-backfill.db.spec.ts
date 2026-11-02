import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { CryptoService } from '../common/crypto.service';
import { Company, User, ResourceRecord, SessionDevice, SessionShop, AuditLog } from '../entities';
import { backfillWithdrawal, type WithdrawalSource } from './withdrawal-backfill';
const db = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
db('提现资料专项补迁（隔离MySQL）', () => {
  let ds: DataSource;
  const crypto = new CryptoService({ test: randomBytes(32) }, 'test');
  beforeAll(async () => { ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true } as never).initialize(); });
  afterAll(async () => { await ds?.destroy(); });
  async function fixture() {
    const tag = randomBytes(5).toString('hex');
    const c = await ds.manager.save(Company, ds.manager.create(Company, { name: `补迁公司${tag}`, code: tag, status: 'active' }));
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, name: '执行管理员', account: tag, passwordHash: 'test-only', status: 'active', isCompanyAdmin: true, mustChangePassword: false }));
    const store = await ds.manager.save(ResourceRecord, ds.manager.create(ResourceRecord, { companyId: c.id, type: 'stores', title: '合成店铺', status: 'normal', data: { name: '合成店铺', platform: 'pdd' }, searchText: '合成店铺', uniqueKey: null }));
    await ds.query('INSERT INTO legacy_import_links (source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES (?,?,?,?,?,?,?)', ['legacy-oa',3,c.id,'stores:44','stores',store.id,'a'.repeat(64)]);
    const source: WithdrawalSource = { company: { id: 3, name: c.name }, backupDigest: 'b'.repeat(64), workspace: { id: 17, company_id: 3, workspace_key: 'finance_withdrawal' },
      devices: [{ id: 'device-a', company_id: 3, workspace_id: 17, name: '出纳电脑', platform: 'win32', agent_version: '1.0.0', status: 'active' }],
      shops: [{ id: 9, company_id: 3, workspace_id: 17, store_id: 44, assigned_device_id: 'device-a', status: 'active', withdrawal_login_account: 'synthetic-account', withdrawal_login_password: 'cipher-fixture', auto_login_enabled: 1 }],
      decryptPassword: (value) => { if (value !== 'cipher-fixture') throw Error('private-test-password'); return 'private-test-password'; } };
    const opts = { companyId: c.id, actorId: user.id, expectedName: c.name };
    return { c, user, store, source, opts };
  }
  it('空跑回滚；原映射/账号和加密密码迁入，电脑待绑定，无任务/远程/外发；复跑保留新站编辑', async () => {
    const f = await fixture();
    const preview = await backfillWithdrawal(ds, crypto, f.source, f.opts);
    expect(preview).toMatchObject({ applied: false, createdDevices: 1, createdShops: 1 });
    expect(await ds.manager.countBy(SessionShop, { companyId: f.c.id })).toBe(0);
    expect(await ds.manager.countBy(SessionDevice, { companyId: f.c.id })).toBe(0);
    const result = await backfillWithdrawal(ds, crypto, f.source, { ...f.opts, apply: true, expectedFingerprint: preview.fingerprint, targetBackupDigest: 'c'.repeat(64) });
    expect(result.applied).toBe(true);
    const shop = await ds.manager.findOneByOrFail(SessionShop, { companyId: f.c.id });
    const device = await ds.manager.findOneByOrFail(SessionDevice, { companyId: f.c.id });
    expect(shop).toMatchObject({ workspace: 'finance_withdrawal', storeId: f.store.id, deviceId: device.id, loginAccount: 'synthetic-account', loginState: 'none', autoLogin: true });
    expect(crypto.decrypt(shop.loginPasswordEnc!)).toBe('private-test-password'); expect(shop.loginPasswordEnc).not.toContain('private-test-password');
    expect(device).toMatchObject({ status: 'revoked', lastSeenAt: null });
    for (const table of ['session_open_requests', 'session_remote_sessions', 'outbox_jobs']) expect(Number((await ds.query(`SELECT COUNT(*) n FROM ${table} WHERE company_id=?`, [f.c.id]))[0].n)).toBe(0);
    expect(await ds.manager.countBy(AuditLog, { companyId: f.c.id, action: 'migration.withdrawal-backfill' })).toBe(1);
    expect((await ds.manager.findOneByOrFail(AuditLog, { companyId: f.c.id, action: 'migration.withdrawal-backfill' })).detail).toMatchObject({ applied: true });
    await ds.manager.update(SessionShop, shop.id, { loginAccount: 'new-manual-account', autoLogin: false });
    const again = await backfillWithdrawal(ds, crypto, f.source, f.opts);
    expect(again).toMatchObject({ createdShops: 0, createdDevices: 0, reusedShops: 1, reusedDevices: 1 });
    await backfillWithdrawal(ds, crypto, f.source, { ...f.opts, apply: true, expectedFingerprint: again.fingerprint, targetBackupDigest: 'd'.repeat(64) });
    expect((await ds.manager.findOneByOrFail(SessionShop, { id: shop.id })).loginAccount).toBe('new-manual-account');
  });
  it('跨公司/跨工作区/非管理员及缺失店铺映射拒绝；全部写入回滚', async () => {
    const a = await fixture(), b = await fixture();
    await expect(backfillWithdrawal(ds, crypto, { ...a.source, devices: [{ ...a.source.devices[0], company_id: 999 }] }, a.opts)).rejects.toThrow('其他公司');
    await expect(backfillWithdrawal(ds, crypto, { ...a.source, workspace: { ...a.source.workspace, workspace_key: 'company_store_maintenance' } }, a.opts)).rejects.toThrow('工作区');
    await expect(backfillWithdrawal(ds, crypto, a.source, { ...a.opts, actorId: b.user.id })).rejects.toThrow('管理员');
    await ds.query('DELETE FROM legacy_import_links WHERE company_id=?', [a.c.id]);
    await expect(backfillWithdrawal(ds, crypto, a.source, a.opts)).rejects.toThrow('缺少同公司');
    expect(await ds.manager.countBy(SessionDevice, { companyId: a.c.id })).toBe(0);
  });
  it('新站已有资料/预览后改变/来源变更/解密失败均阻止，且错误和报告不含密码', async () => {
    const f = await fixture(), preview = await backfillWithdrawal(ds, crypto, f.source, f.opts);
    await ds.manager.save(SessionShop, ds.manager.create(SessionShop, { companyId: f.c.id, workspace: 'finance_withdrawal', storeId: f.store.id, deviceId: null, autoLogin: false, status: 'active', loginState: 'none' }));
    await expect(backfillWithdrawal(ds, crypto, f.source, { ...f.opts, apply: true, expectedFingerprint: preview.fingerprint, targetBackupDigest: 'd'.repeat(64) })).rejects.toThrow('数据已变化');
    await expect(backfillWithdrawal(ds, crypto, f.source, f.opts)).rejects.toThrow('已有提现资料');
    await ds.manager.delete(SessionShop, { companyId: f.c.id });
    await expect(backfillWithdrawal(ds, crypto, { ...f.source, decryptPassword: () => { throw Error('private-test-password'); } }, f.opts)).rejects.toThrow('密码无法解密');
    expect(await ds.manager.countBy(SessionDevice, { companyId: f.c.id })).toBe(0);
    const plan = await backfillWithdrawal(ds, crypto, f.source, f.opts);
    expect(JSON.stringify(plan)).not.toMatch(/private-test-password|synthetic-account|cipher-fixture/);
  });
});
