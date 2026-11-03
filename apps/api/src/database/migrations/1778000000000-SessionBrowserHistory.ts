import { MigrationInterface, QueryRunner } from 'typeorm';

/** UUID is the session identity. Second-resolution history timestamps cannot
 * distinguish a browser that was closed and reopened in the same second. */
export class SessionBrowserHistory1778000000000 implements MigrationInterface {
  name = 'SessionBrowserHistory1778000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE sm_legacy_managed_browser_sessions DROP INDEX uk_managed_browser_device_profile_opened, ADD INDEX idx_managed_browser_device_profile_opened (device_id, local_profile_id, opened_at)');
  }

  async down(q: QueryRunner): Promise<void> {
    const duplicates = await q.query('SELECT 1 AS duplicate FROM sm_legacy_managed_browser_sessions GROUP BY device_id, local_profile_id, opened_at HAVING COUNT(*) > 1 LIMIT 1');
    if (duplicates.length) throw new Error('同秒浏览器历史已存在，不能恢复旧唯一索引；会话数据保持不变');
    await q.query('ALTER TABLE sm_legacy_managed_browser_sessions DROP INDEX idx_managed_browser_device_profile_opened, ADD UNIQUE INDEX uk_managed_browser_device_profile_opened (device_id, local_profile_id, opened_at)');
  }
}
