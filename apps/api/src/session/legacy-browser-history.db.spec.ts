import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { SessionBrowserHistory1778000000000 } from '../database/migrations/1778000000000-SessionBrowserHistory';

const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('同秒关闭后重新打开的浏览器历史（独立 MySQL 结构）', () => {
  let admin: DataSource, ds: DataSource, database: string;
  const migration = new SessionBrowserHistory1778000000000();
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '')) throw new Error('Isolated loopback database required');
    admin = await new DataSource(buildDataSourceOptions()).initialize();
    database = 'kudesi_oa_test_browser_history_' + randomBytes(6).toString('hex');
    await admin.query('CREATE DATABASE `' + database + '`');
    ds = await new DataSource(buildDataSourceOptions({ ...process.env, DB_NAME: database })).initialize();
    await ds.query('CREATE TABLE sm_legacy_managed_browser_sessions (id CHAR(36) PRIMARY KEY, device_id CHAR(36) NOT NULL, local_profile_id CHAR(36) NOT NULL, opened_at TIMESTAMP NOT NULL, status VARCHAR(20) NOT NULL, UNIQUE INDEX uk_managed_browser_device_profile_opened(device_id, local_profile_id, opened_at))');
  }, 30000);
  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (admin?.isInitialized) { if (/^kudesi_oa_test_browser_history_[a-f0-9]{12}$/.test(database)) await admin.query('DROP DATABASE `' + database + '`'); await admin.destroy(); }
  });
  it('保留已关闭历史，同一秒重开仍可写入，主键保持唯一；重复历史阻止回退而不删数据', async () => {
    const device = randomUUID(), profile = randomUUID();
    const sql = 'INSERT INTO sm_legacy_managed_browser_sessions(id,device_id,local_profile_id,opened_at,status) VALUES(?,?,?,\'2026-01-01 00:00:00\',?)';
    const first = randomUUID(), second = randomUUID();
    await ds.query(sql, [first, device, profile, 'closed']);
    await expect(ds.query(sql, [second, device, profile, 'open'])).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
    const q = ds.createQueryRunner(); await q.connect();
    try {
      await migration.up(q);
      await ds.query(sql, [second, device, profile, 'open']);
      expect(await ds.query('SELECT id,status FROM sm_legacy_managed_browser_sessions ORDER BY status')).toEqual([{ id: first, status: 'closed' }, { id: second, status: 'open' }]);
      await expect(ds.query(sql, [second, randomUUID(), profile, 'open'])).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
      await expect(migration.down(q)).rejects.toThrow('同秒浏览器历史');
      expect(Number((await ds.query('SELECT COUNT(*) n FROM sm_legacy_managed_browser_sessions'))[0].n)).toBe(2);
      await ds.query('DELETE FROM sm_legacy_managed_browser_sessions WHERE id=?', [second]);
      await migration.down(q);
      await expect(ds.query(sql, [second, device, profile, 'open'])).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
    } finally { await q.release(); }
  });
});
