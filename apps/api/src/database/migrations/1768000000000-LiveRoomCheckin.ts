import { MigrationInterface, QueryRunner } from 'typeorm';
export class LiveRoomCheckin1768000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE live_sessions
      ADD checkin_mode TINYINT(1) NOT NULL DEFAULT 0,
      ADD first_reported_at DATETIME NULL, ADD report_deadline DATETIME NULL,
      ADD report_locked_at DATETIME NULL, ADD auto_submit_error VARCHAR(500) NULL,
      ADD orders_capture_status VARCHAR(16) NOT NULL DEFAULT 'legacy',
      ADD orders_capture_error VARCHAR(500) NULL, ADD orders_captured_at DATETIME NULL,
      ADD INDEX idx_live_report_due (report_deadline, status)`);
    await q.query('ALTER TABLE live_session_reports ADD order_basis_json JSON NULL');
    await q.query(`CREATE TABLE live_session_checkins (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL, session_id BIGINT UNSIGNED NOT NULL, user_id INT NOT NULL,
      role VARCHAR(16) NOT NULL, start_at DATETIME NOT NULL, end_at DATETIME NULL,
      confirmation_json JSON NOT NULL, UNIQUE KEY uq_live_checkin (company_id,session_id,role),
      INDEX idx_live_checkin_user (company_id,user_id,start_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await q.query(`CREATE TABLE live_session_order_snapshots (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL, session_id BIGINT UNSIGNED NOT NULL, store_id BIGINT UNSIGNED NOT NULL,
      platform VARCHAR(32) NOT NULL, account_ids_json JSON NOT NULL,
      shop_id VARCHAR(64) NOT NULL, order_id VARCHAR(100) NOT NULL, inner_order_id VARCHAR(100) NULL,
      order_at DATETIME NOT NULL, pay_time DATETIME NULL, paid TINYINT(1) NOT NULL,
      amount_cents BIGINT NOT NULL, refund_cents BIGINT NOT NULL, baseline_refund_cents BIGINT NOT NULL DEFAULT 0,
      order_status VARCHAR(100) NOT NULL, refund_json JSON NOT NULL, captured_at DATETIME NOT NULL,
      UNIQUE KEY uq_live_snapshot_order (company_id,shop_id,order_id),
      INDEX idx_live_snapshot_session (company_id,session_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner) {
    const [r] = await q.query('SELECT (SELECT COUNT(*) FROM live_sessions WHERE checkin_mode=1 OR report_deadline IS NOT NULL)+(SELECT COUNT(*) FROM live_session_checkins)+(SELECT COUNT(*) FROM live_session_order_snapshots) n');
    if (Number(r.n)) throw new Error('已有扫码打卡或锁场数据，不能回退结构');
    await q.query('DROP TABLE live_session_order_snapshots');
    await q.query('DROP TABLE live_session_checkins');
    await q.query('ALTER TABLE live_session_reports DROP COLUMN order_basis_json');
    await q.query(`ALTER TABLE live_sessions DROP INDEX idx_live_report_due,
      DROP COLUMN checkin_mode, DROP COLUMN first_reported_at, DROP COLUMN report_deadline,
      DROP COLUMN report_locked_at, DROP COLUMN auto_submit_error, DROP COLUMN orders_capture_status,
      DROP COLUMN orders_capture_error, DROP COLUMN orders_captured_at`);
  }
}
