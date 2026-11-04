import { MigrationInterface, QueryRunner } from 'typeorm';

export class LiveSplitSettlement1794000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE live_settlements DROP INDEX uq_live_settle_period,
      ADD settlement_kind VARCHAR(12) NOT NULL DEFAULT 'mixed', ADD user_ids JSON NULL,
      ADD scope_key VARCHAR(1200) NOT NULL DEFAULT 'legacy', ADD source_fingerprint LONGTEXT NULL,
      ADD excluded_json JSON NULL, ADD paid_total_cents BIGINT NOT NULL DEFAULT 0,
      ADD original_settlement_id INT UNSIGNED NULL, ADD correction_key VARCHAR(160) NULL, ADD UNIQUE KEY uq_live_correction(company_id,correction_key),
      ADD void_reason VARCHAR(500) NULL, ADD KEY idx_live_settle_period(company_id,period_from,period_to)`);
    await q.query(`ALTER TABLE live_settlement_lines ADD original_line_id INT UNSIGNED NULL, ADD released_at DATETIME NULL, ADD display_snapshot JSON NULL,
      ADD active_commission_id INT UNSIGNED GENERATED ALWAYS AS (IF(released_at IS NULL,commission_record_id,NULL)) STORED,
      ADD active_wage_id INT UNSIGNED GENERATED ALWAYS AS (IF(released_at IS NULL,wage_record_id,NULL)) STORED,
      ADD active_daily_id INT UNSIGNED GENERATED ALWAYS AS (IF(released_at IS NULL,daily_work_id,NULL)) STORED,
      ADD UNIQUE KEY uq_live_paid_commission(company_id,active_commission_id),
      ADD UNIQUE KEY uq_live_paid_wage(company_id,active_wage_id),
      ADD UNIQUE KEY uq_live_paid_daily(company_id,active_daily_id)`);
    await q.query(`CREATE TABLE live_settlement_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, company_id INT UNSIGNED NOT NULL,
      settlement_id INT UNSIGNED NOT NULL, event_type VARCHAR(24) NOT NULL, actor_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NULL, amount_cents BIGINT NOT NULL DEFAULT 0, request_key VARCHAR(100) NULL, business_key VARCHAR(250) NULL,
      detail_json JSON NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_live_settle_event(company_id,settlement_id,id), UNIQUE KEY uq_live_settle_business(company_id,business_key), UNIQUE KEY uq_live_settle_event(company_id,request_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner) {
    const [r] = await q.query('SELECT (SELECT COUNT(*) FROM live_settlement_events)+(SELECT COUNT(*) FROM live_settlements WHERE source_fingerprint IS NOT NULL) n');
    if(Number(r.n)) throw new Error('独立结算已有业务数据，不能回退结构');
    await q.query('DROP TABLE live_settlement_events');
    await q.query('ALTER TABLE live_settlement_lines DROP INDEX uq_live_paid_commission,DROP INDEX uq_live_paid_wage,DROP INDEX uq_live_paid_daily,DROP active_commission_id,DROP active_wage_id,DROP active_daily_id,DROP original_line_id,DROP released_at,DROP display_snapshot');
    await q.query('ALTER TABLE live_settlements DROP INDEX uq_live_correction,DROP original_settlement_id,DROP correction_key,DROP INDEX idx_live_settle_period,DROP settlement_kind,DROP user_ids,DROP scope_key,DROP source_fingerprint,DROP excluded_json,DROP paid_total_cents,DROP void_reason,ADD UNIQUE KEY uq_live_settle_period(company_id,period_from,period_to)');
  }
}
