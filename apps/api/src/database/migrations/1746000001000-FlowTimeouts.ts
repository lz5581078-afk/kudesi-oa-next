import { MigrationInterface, QueryRunner } from 'typeorm';

/** 流程超时规则、超时事件、处罚台账、督促提醒记录。金额一律整数分。只加表。 */
export class FlowTimeouts1746000001000 implements MigrationInterface {
  name = 'FlowTimeouts1746000001000';

  public async up(q: QueryRunner): Promise<void> {
    const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await q.query(`
      CREATE TABLE flow_timeout_policies (
        company_id INT UNSIGNED NOT NULL,
        template_key VARCHAR(40) NOT NULL DEFAULT '',
        node_key VARCHAR(40) NOT NULL DEFAULT '',
        policy JSON NOT NULL,
        revision INT UNSIGNED NOT NULL DEFAULT 1,
        updated_by INT UNSIGNED NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (company_id, template_key, node_key)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE flow_timeout_incidents (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        work_item_id INT UNSIGNED NOT NULL,
        run_id INT UNSIGNED NOT NULL,
        step_id INT UNSIGNED NOT NULL,
        template_key VARCHAR(40) NOT NULL,
        step_key VARCHAR(40) NOT NULL,
        assignee_id INT UNSIGNED NOT NULL,
        sole_owner TINYINT(1) NOT NULL DEFAULT 1,
        title VARCHAR(255) NOT NULL,
        due_at DATETIME NOT NULL,
        ended_at DATETIME NULL,
        overdue_minutes INT UNSIGNED NOT NULL DEFAULT 0,
        policy JSON NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'open',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_flow_incident_item (company_id, work_item_id, due_at),
        KEY idx_flow_incident_ledger (company_id, template_key, id),
        KEY idx_flow_incident_open (company_id, status)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE flow_timeout_penalties (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        penalty_key CHAR(64) NOT NULL,
        incident_id INT UNSIGNED NOT NULL,
        assignee_id INT UNSIGNED NOT NULL,
        calculated_cents INT UNSIGNED NOT NULL,
        confirmed_cents INT UNSIGNED NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'pending',
        reason VARCHAR(500) NULL,
        revision INT UNSIGNED NOT NULL DEFAULT 1,
        confirmed_by INT UNSIGNED NULL,
        confirmed_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_flow_penalty_key (company_id, penalty_key),
        KEY idx_flow_penalty_incident (company_id, incident_id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE flow_timeout_events (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        kind VARCHAR(20) NOT NULL,
        template_key VARCHAR(40) NOT NULL DEFAULT '',
        node_key VARCHAR(40) NOT NULL DEFAULT '',
        ref_id INT UNSIGNED NULL,
        before_json JSON NULL,
        after_json JSON NOT NULL,
        actor_id INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_flow_timeout_event (company_id, kind, id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE flow_reminder_logs (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        work_item_id INT UNSIGNED NOT NULL,
        kind VARCHAR(24) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_flow_reminder (work_item_id, kind)
      ) ${tail}`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ['flow_reminder_logs', 'flow_timeout_events', 'flow_timeout_penalties', 'flow_timeout_incidents', 'flow_timeout_policies']) await q.query(`DROP TABLE IF EXISTS ${t}`);
  }
}
