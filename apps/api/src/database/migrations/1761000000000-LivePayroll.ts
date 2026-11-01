import { MigrationInterface, QueryRunner } from 'typeorm';

export class LivePayroll1761000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE users ADD live_trial TINYINT(1) NOT NULL DEFAULT 0`);
    await q.query(`CREATE TABLE live_room_settings (
      company_id INT UNSIGNED NOT NULL, room_id INT UNSIGNED NOT NULL,
      owner_user_id INT UNSIGNED NULL, products VARCHAR(1000) NOT NULL DEFAULT '',
      updated_by INT UNSIGNED NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY(company_id, room_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await q.query(
      `ALTER TABLE live_sessions ADD report_source VARCHAR(12) NOT NULL DEFAULT 'normal', ADD manual_reason VARCHAR(500) NULL, ADD manual_actor_id INT UNSIGNED NULL`,
    );
    await q.query(`ALTER TABLE live_session_reports ADD manual_actor_id INT UNSIGNED NULL`);
    await q.query(
      `ALTER TABLE live_wage_records DROP INDEX uq_live_wage_session, ADD role VARCHAR(12) NOT NULL DEFAULT 'anchor', ADD UNIQUE KEY uq_live_wage_role(company_id,session_id,role)`,
    );
    await q.query(`ALTER TABLE live_settlements DROP INDEX uq_live_settle_month,
      ADD period_from DATE NULL, ADD period_to DATE NULL, ADD wage_total_cents BIGINT NOT NULL DEFAULT 0,
      ADD UNIQUE KEY uq_live_settle_period(company_id,period_from,period_to)`);
    await q.query(`ALTER TABLE live_settlement_lines ADD wage_record_id INT UNSIGNED NULL,
      ADD wage_cents BIGINT NOT NULL DEFAULT 0, ADD wage_minutes INT UNSIGNED NOT NULL DEFAULT 0,
      ADD hourly_rate_cents BIGINT NOT NULL DEFAULT 0`);
  }
  async down(q: QueryRunner) {
    const [used] =
      await q.query(`SELECT (SELECT COUNT(*) FROM live_room_settings) + (SELECT COUNT(*) FROM users WHERE live_trial=1) +
      (SELECT COUNT(*) FROM live_wage_records WHERE role<>'anchor') +
      (SELECT COUNT(*) FROM live_settlements WHERE period_from IS NOT NULL) +
      (SELECT COUNT(*) FROM live_sessions WHERE report_source='manual') n`);
    if (Number(used.n)) throw new Error('直播工资已有新业务数据，不能回退结构');
    await q.query(
      `ALTER TABLE live_settlement_lines DROP COLUMN wage_record_id, DROP COLUMN wage_cents, DROP COLUMN wage_minutes, DROP COLUMN hourly_rate_cents`,
    );
    await q.query(
      `ALTER TABLE live_settlements DROP INDEX uq_live_settle_period, DROP COLUMN period_from, DROP COLUMN period_to, DROP COLUMN wage_total_cents, ADD UNIQUE KEY uq_live_settle_month(company_id,month)`,
    );
    await q.query(
      `ALTER TABLE live_wage_records DROP INDEX uq_live_wage_role, DROP COLUMN role, ADD UNIQUE KEY uq_live_wage_session(company_id,session_id)`,
    );
    await q.query(`ALTER TABLE live_session_reports DROP COLUMN manual_actor_id`);
    await q.query(
      `ALTER TABLE live_sessions DROP COLUMN report_source, DROP COLUMN manual_reason, DROP COLUMN manual_actor_id`,
    );
    await q.query(`DROP TABLE live_room_settings`);
    await q.query(`ALTER TABLE users DROP COLUMN live_trial`);
  }
}
