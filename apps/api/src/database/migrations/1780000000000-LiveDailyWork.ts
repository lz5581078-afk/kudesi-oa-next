import { MigrationInterface, QueryRunner } from 'typeorm';
export class LiveDailyWork1780000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE live_daily_work (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, company_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL, role VARCHAR(12) NOT NULL, work_date DATE NOT NULL,
      planned_start DATETIME NOT NULL, planned_end DATETIME NOT NULL, content VARCHAR(500) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'scheduled', actual_start DATETIME NULL, actual_end DATETIME NULL,
      hourly_rate_cents BIGINT NULL, minutes INT UNSIGNED NULL, amount_cents BIGINT NULL,
      approved_minutes INT UNSIGNED NULL, review_note VARCHAR(500) NULL, report VARCHAR(1000) NULL, flow_run_id INT UNSIGNED NULL, return_reason VARCHAR(500) NULL,
      overdue_notified_at DATETIME NULL, created_by INT UNSIGNED NOT NULL, updated_by INT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_daily_person (company_id,user_id,status), KEY idx_daily_date(company_id,work_date),
      KEY idx_daily_overdue(status,planned_end)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await q.query(
      'ALTER TABLE live_settlement_lines MODIFY commission_record_id INT UNSIGNED NULL, MODIFY session_id INT UNSIGNED NULL, ADD daily_work_id INT UNSIGNED NULL, ADD UNIQUE KEY uq_settlement_daily(company_id,settlement_id,daily_work_id)',
    );
  }
  async down(q: QueryRunner) {
    // 有日常工资的结算单必须先由业务核对；不静默删除已审核工资。
    await q.query(
      'ALTER TABLE live_settlement_lines MODIFY commission_record_id INT UNSIGNED NOT NULL, MODIFY session_id INT UNSIGNED NOT NULL, DROP INDEX uq_settlement_daily, DROP COLUMN daily_work_id',
    );
    await q.query('DROP TABLE live_daily_work');
  }
}
