import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 售后工单、订单申诉、兜底监督。
 * 流转（谁办、几步、多久）都在统一流程引擎里（flow_runs），这里只存业务本身：工单/申诉的内容与凭证、跟进记录、监督异常与规则。
 * 全是新表，只加不删，向后兼容；金额一律整数分。
 */
export class AfterSalesSupervision1748000000000 implements MigrationInterface {
  name = 'AfterSalesSupervision1748000000000';

  public async up(q: QueryRunner): Promise<void> {
    const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await q.query(`
      CREATE TABLE after_sales_cases (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        case_no VARCHAR(32) NULL,
        run_id INT UNSIGNED NOT NULL,
        store_id INT UNSIGNED NOT NULL,
        order_no VARCHAR(80) NOT NULL,
        buyer_name VARCHAR(80) NULL,
        case_type VARCHAR(24) NOT NULL,
        amount_cents BIGINT NOT NULL DEFAULT 0,
        refund_cents BIGINT NULL,
        reason VARCHAR(500) NOT NULL,
        resolution VARCHAR(500) NULL,
        due_date DATE NULL,
        source VARCHAR(16) NOT NULL DEFAULT 'manual',
        source_key VARCHAR(100) NULL,
        attachments JSON NULL,
        created_by INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_after_sales_run (run_id),
        UNIQUE KEY uq_after_sales_no (company_id, case_no),
        UNIQUE KEY uq_after_sales_source (company_id, source_key),
        KEY idx_after_sales_order (company_id, order_no),
        KEY idx_after_sales_store (company_id, store_id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE order_appeals (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        appeal_no VARCHAR(32) NULL,
        run_id INT UNSIGNED NOT NULL,
        store_id INT UNSIGNED NOT NULL,
        appeal_type VARCHAR(24) NOT NULL,
        order_no VARCHAR(80) NOT NULL,
        amount_cents BIGINT NOT NULL DEFAULT 0,
        reason VARCHAR(1000) NOT NULL,
        deadline_at DATETIME NULL,
        platform_appeal_no VARCHAR(80) NULL,
        submitted_at DATE NULL,
        result VARCHAR(12) NULL,
        result_note VARCHAR(500) NULL,
        parent_id INT UNSIGNED NULL,
        source VARCHAR(16) NOT NULL DEFAULT 'manual',
        source_key VARCHAR(100) NULL,
        evidence JSON NULL,
        created_by INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_appeal_run (run_id),
        UNIQUE KEY uq_appeal_no (company_id, appeal_no),
        UNIQUE KEY uq_appeal_source (company_id, source_key),
        KEY idx_appeal_order (company_id, order_no),
        KEY idx_appeal_store (company_id, store_id),
        KEY idx_appeal_parent (company_id, parent_id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE case_logs (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        target_type VARCHAR(16) NOT NULL,
        target_id INT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NULL,
        kind VARCHAR(12) NOT NULL DEFAULT 'note',
        content VARCHAR(1000) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_case_logs_target (company_id, target_type, target_id, id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE supervision_exceptions (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        source_type VARCHAR(16) NOT NULL,
        source_id INT UNSIGNED NULL,
        source_key VARCHAR(80) NOT NULL,
        run_id INT UNSIGNED NULL,
        title VARCHAR(200) NOT NULL,
        detail VARCHAR(1000) NULL,
        severity VARCHAR(12) NOT NULL DEFAULT 'normal',
        status VARCHAR(12) NOT NULL DEFAULT 'open',
        level TINYINT UNSIGNED NOT NULL DEFAULT 1,
        owner_id INT UNSIGNED NULL,
        store_id INT UNSIGNED NULL,
        due_at DATETIME NULL,
        close_reason VARCHAR(500) NULL,
        closed_by INT UNSIGNED NULL,
        closed_at DATETIME NULL,
        created_by INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        escalated_at DATETIME NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_supervision_source (company_id, source_key),
        KEY idx_supervision_open (company_id, status, severity),
        KEY idx_supervision_owner (company_id, owner_id, status)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE supervision_rules (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        target_type VARCHAR(16) NOT NULL,
        name VARCHAR(100) NOT NULL,
        overdue_minutes INT UNSIGNED NOT NULL DEFAULT 0,
        supervisor_visible_minutes INT UNSIGNED NOT NULL DEFAULT 0,
        boss_visible_minutes INT UNSIGNED NOT NULL DEFAULT 1440,
        abnormal_condition VARCHAR(240) NOT NULL DEFAULT '',
        close_requires_reason TINYINT(1) NOT NULL DEFAULT 1,
        status VARCHAR(12) NOT NULL DEFAULT 'active',
        updated_by INT UNSIGNED NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_supervision_rule (company_id, target_type)
      ) ${tail}`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ['supervision_rules', 'supervision_exceptions', 'case_logs', 'order_appeals', 'after_sales_cases']) await q.query(`DROP TABLE IF EXISTS ${t}`);
  }
}
