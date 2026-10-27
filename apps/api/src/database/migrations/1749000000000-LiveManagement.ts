import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 直播管理：排场、场次、下播报告与勾选订单、提成规则版本、提成记录、主播工资、月底结算。
 * 金额一律整数分；比例是「百分数×100」的整数（3.5% 存 350）；投产存 ×10000 的整数。时间是北京时间（连接时区 +08:00）。
 * 迁移只建表，默认提成规则由公司开通和种子脚本写入。
 */
export class LiveManagement1749000000000 implements MigrationInterface {
  name = 'LiveManagement1749000000000';
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE live_schedules (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      room_id INT UNSIGNED NOT NULL,
      room_name VARCHAR(200) NOT NULL,
      schedule_date DATE NOT NULL,
      start_at DATETIME NOT NULL,
      end_at DATETIME NOT NULL,
      anchor_user_id INT UNSIGNED NOT NULL,
      control_user_id INT UNSIGNED NULL,
      operator_user_id INT UNSIGNED NULL,
      douyin_account_id INT UNSIGNED NOT NULL,
      douyin_account_name VARCHAR(200) NOT NULL,
      store_id INT UNSIGNED NULL,
      store_name VARCHAR(200) NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'scheduled',
      note VARCHAR(500) NULL,
      cancel_reason VARCHAR(500) NULL,
      session_id INT UNSIGNED NULL,
      notification_version INT UNSIGNED NOT NULL DEFAULT 1,
      reminder_version INT UNSIGNED NOT NULL DEFAULT 0,
      created_by INT UNSIGNED NOT NULL,
      updated_by INT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_live_sched_day (company_id, schedule_date, start_at),
      KEY idx_live_sched_room (company_id, room_id, start_at),
      KEY idx_live_sched_anchor (company_id, anchor_user_id, start_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await q.query(`CREATE TABLE live_sessions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      schedule_id INT UNSIGNED NULL,
      room_id INT UNSIGNED NOT NULL,
      room_name VARCHAR(200) NOT NULL,
      anchor_user_id INT UNSIGNED NOT NULL,
      control_user_id INT UNSIGNED NULL,
      operator_user_id INT UNSIGNED NULL,
      douyin_account_id INT UNSIGNED NOT NULL,
      douyin_account_name VARCHAR(200) NOT NULL,
      store_id INT UNSIGNED NULL,
      store_name VARCHAR(200) NULL,
      jst_shop_id VARCHAR(64) NULL,
      session_date DATE NOT NULL,
      start_at DATETIME NOT NULL,
      end_at DATETIME NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'live',
      started_by INT UNSIGNED NOT NULL,
      started_role VARCHAR(12) NOT NULL,
      return_reason VARCHAR(500) NULL,
      flow_run_id INT UNSIGNED NULL,
      submitted_by INT UNSIGNED NULL,
      submitted_at DATETIME NULL,
      final_sales_cents BIGINT NULL,
      final_sales_source VARCHAR(20) NULL,
      final_sales_reason VARCHAR(500) NULL,
      approved_by INT UNSIGNED NULL,
      approved_at DATETIME NULL,
      revision INT UNSIGNED NOT NULL DEFAULT 1,
      live_room_key INT UNSIGNED GENERATED ALWAYS AS (IF(status = 'live', room_id, NULL)) STORED,
      live_anchor_key INT UNSIGNED GENERATED ALWAYS AS (IF(status = 'live', anchor_user_id, NULL)) STORED,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_live_room_live (company_id, live_room_key),
      UNIQUE KEY uq_live_anchor_live (company_id, live_anchor_key),
      KEY idx_live_sess_day (company_id, session_date, start_at),
      KEY idx_live_sess_status (company_id, status),
      KEY idx_live_sess_anchor (company_id, anchor_user_id, start_at),
      KEY idx_live_sess_control (company_id, control_user_id, start_at),
      KEY idx_live_sess_operator (company_id, operator_user_id, start_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await q.query(`CREATE TABLE live_session_products (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      session_id INT UNSIGNED NOT NULL,
      base_code_id INT UNSIGNED NOT NULL,
      code_snapshot VARCHAR(100) NOT NULL,
      name_snapshot VARCHAR(200) NOT NULL,
      spec_snapshot VARCHAR(300) NULL,
      sort_order INT NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      UNIQUE KEY uq_live_prod (session_id, base_code_id),
      KEY idx_live_prod_company (company_id, session_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await q.query(`CREATE TABLE live_session_reports (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      session_id INT UNSIGNED NOT NULL,
      role VARCHAR(12) NOT NULL,
      reporter_user_id INT UNSIGNED NOT NULL,
      end_at DATETIME NOT NULL,
      sales_cents BIGINT NOT NULL,
      ad_spend_cents BIGINT NULL,
      order_source VARCHAR(12) NOT NULL DEFAULT 'jushuitan',
      orders_total_cents BIGINT NULL,
      order_count INT UNSIGNED NOT NULL DEFAULT 0,
      note VARCHAR(500) NULL,
      revision INT UNSIGNED NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_live_report_role (company_id, session_id, role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await q.query(`CREATE TABLE live_session_orders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      session_id INT UNSIGNED NOT NULL,
      report_id INT UNSIGNED NOT NULL,
      order_id VARCHAR(64) NOT NULL,
      inner_order_id VARCHAR(64) NULL,
      amount_cents BIGINT NOT NULL,
      pay_time DATETIME NULL,
      order_status VARCHAR(32) NULL,
      shop_id VARCHAR(64) NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_live_order_report (report_id, order_id),
      KEY idx_live_order_session (company_id, session_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await q.query(`CREATE TABLE live_commission_rule_versions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      effective_from DATE NOT NULL,
      rules_json JSON NOT NULL,
      note VARCHAR(500) NULL,
      created_by INT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_live_rule_day (company_id, effective_from)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await q.query(`CREATE TABLE live_commission_records (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      session_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      role VARCHAR(12) NOT NULL,
      session_date DATE NOT NULL,
      final_sales_cents BIGINT NOT NULL,
      ad_spend_cents BIGINT NOT NULL DEFAULT 0,
      roi_scaled BIGINT NULL,
      below_roi TINYINT(1) NOT NULL DEFAULT 0,
      rate_units INT NOT NULL,
      amount_cents BIGINT NOT NULL,
      rule_version_id INT UNSIGNED NOT NULL,
      rule_snapshot JSON NOT NULL,
      approved_by INT UNSIGNED NOT NULL,
      approved_at DATETIME NOT NULL,
      flow_run_id INT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_live_comm_role (company_id, session_id, role),
      KEY idx_live_comm_user (company_id, user_id, session_date),
      KEY idx_live_comm_day (company_id, session_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await q.query(`CREATE TABLE live_wage_records (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      session_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      session_date DATE NOT NULL,
      start_at DATETIME NOT NULL,
      end_at DATETIME NOT NULL,
      minutes INT UNSIGNED NOT NULL,
      hourly_rate_cents BIGINT NOT NULL,
      rate_source VARCHAR(12) NOT NULL,
      amount_cents BIGINT NOT NULL,
      adjust_note VARCHAR(500) NULL,
      review_snapshot JSON NULL,
      approved_by INT UNSIGNED NOT NULL,
      approved_at DATETIME NOT NULL,
      flow_run_id INT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_live_wage_session (company_id, session_id),
      KEY idx_live_wage_user (company_id, user_id, session_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await q.query(`CREATE TABLE live_settlements (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      month CHAR(7) NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'draft',
      record_count INT UNSIGNED NOT NULL DEFAULT 0,
      commission_total_cents BIGINT NOT NULL DEFAULT 0,
      refund_total_cents BIGINT NOT NULL DEFAULT 0,
      deduction_total_cents BIGINT NOT NULL DEFAULT 0,
      payable_total_cents BIGINT NOT NULL DEFAULT 0,
      refunds_checked_at DATETIME NULL,
      note VARCHAR(500) NULL,
      return_reason VARCHAR(500) NULL,
      flow_run_id INT UNSIGNED NULL,
      created_by INT UNSIGNED NOT NULL,
      updated_by INT UNSIGNED NULL,
      submitted_by INT UNSIGNED NULL,
      submitted_at DATETIME NULL,
      approved_by INT UNSIGNED NULL,
      approved_at DATETIME NULL,
      revision INT UNSIGNED NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_live_settle_month (company_id, month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await q.query(`CREATE TABLE live_settlement_lines (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      settlement_id INT UNSIGNED NOT NULL,
      commission_record_id INT UNSIGNED NOT NULL,
      session_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      role VARCHAR(12) NOT NULL,
      session_date DATE NOT NULL,
      final_sales_cents BIGINT NOT NULL,
      rate_units INT NOT NULL,
      commission_cents BIGINT NOT NULL,
      order_count INT UNSIGNED NOT NULL DEFAULT 0,
      orders_total_cents BIGINT NOT NULL DEFAULT 0,
      refund_cents BIGINT NOT NULL DEFAULT 0,
      deduction_cents BIGINT NOT NULL DEFAULT 0,
      payable_cents BIGINT NOT NULL,
      PRIMARY KEY (id),
      KEY idx_live_line_settle (company_id, settlement_id, commission_record_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await q.query(`CREATE TABLE live_settlement_refunds (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      settlement_id INT UNSIGNED NOT NULL,
      session_id INT UNSIGNED NOT NULL,
      order_id VARCHAR(64) NOT NULL,
      order_amount_cents BIGINT NOT NULL,
      refund_cents BIGINT NOT NULL DEFAULT 0,
      refund_source VARCHAR(12) NOT NULL DEFAULT 'none',
      detail_json JSON NULL,
      checked_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      KEY idx_live_refund_settle (company_id, settlement_id, session_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  async down(q: QueryRunner) {
    for (const table of ['live_settlement_refunds', 'live_settlement_lines', 'live_settlements', 'live_wage_records', 'live_commission_records', 'live_commission_rule_versions', 'live_session_orders', 'live_session_reports', 'live_session_products', 'live_sessions', 'live_schedules']) {
      await q.query(`DROP TABLE ${table}`);
    }
  }
}
