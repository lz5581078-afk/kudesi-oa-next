import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0005 统一流程引擎：流程定义（版本化）、流程实例、步骤（每进入一次一行）、待办、抄送、事件、站内通知。
 * 办理人解析、步骤流转全在服务里；这里只存结果和快照。
 */
export class FlowEngine1730000400000 implements MigrationInterface {
  name = 'FlowEngine1730000400000';

  public async up(q: QueryRunner): Promise<void> {
    const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await q.query(`
      CREATE TABLE flow_definitions (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        template_key VARCHAR(40) NOT NULL,
        version INT UNSIGNED NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'draft',
        steps JSON NOT NULL,
        escalate_user_ids JSON NOT NULL,
        created_by INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        published_at DATETIME NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_flow_def_version (company_id, template_key, version),
        KEY idx_flow_def_status (company_id, template_key, status),
        CONSTRAINT fk_flow_def_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE flow_runs (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        definition_id INT UNSIGNED NOT NULL,
        template_key VARCHAR(40) NOT NULL,
        title VARCHAR(200) NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'running',
        requester_id INT UNSIGNED NOT NULL,
        current_step_key VARCHAR(32) NULL,
        payload JSON NOT NULL,
        steps_snapshot JSON NOT NULL,
        escalate_user_ids JSON NOT NULL,
        revision INT UNSIGNED NOT NULL DEFAULT 1,
        due_at DATETIME NULL,
        request_key VARCHAR(80) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        finished_at DATETIME NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_flow_run_request (company_id, request_key),
        KEY idx_flow_run_status (company_id, status, id),
        KEY idx_flow_run_requester (company_id, requester_id, id),
        CONSTRAINT fk_flow_run_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE flow_steps (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        run_id INT UNSIGNED NOT NULL,
        seq INT UNSIGNED NOT NULL,
        step_key VARCHAR(32) NOT NULL,
        step_name VARCHAR(40) NOT NULL,
        step_type VARCHAR(12) NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'active',
        entered_via VARCHAR(12) NOT NULL DEFAULT 'normal',
        recipients JSON NOT NULL,
        handled_by INT UNSIGNED NULL,
        action VARCHAR(12) NULL,
        comment VARCHAR(500) NULL,
        form JSON NULL,
        entered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME NULL,
        due_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_flow_step_run (run_id, seq),
        CONSTRAINT fk_flow_step_run FOREIGN KEY (run_id) REFERENCES flow_runs (id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE work_items (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        kind VARCHAR(12) NOT NULL DEFAULT 'flow',
        run_id INT UNSIGNED NULL,
        step_id INT UNSIGNED NULL,
        assignee_id INT UNSIGNED NOT NULL,
        title VARCHAR(200) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'open',
        due_at DATETIME NULL,
        overdue_notified_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_work_assignee (company_id, assignee_id, status, due_at),
        KEY idx_work_step (step_id),
        KEY idx_work_overdue (status, due_at, overdue_notified_at),
        CONSTRAINT fk_work_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE flow_ccs (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        run_id INT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NOT NULL,
        step_key VARCHAR(32) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_flow_cc (run_id, user_id),
        KEY idx_flow_cc_user (company_id, user_id, id),
        CONSTRAINT fk_flow_cc_run FOREIGN KEY (run_id) REFERENCES flow_runs (id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE flow_events (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        run_id INT UNSIGNED NOT NULL,
        step_id INT UNSIGNED NULL,
        actor_id INT UNSIGNED NOT NULL,
        action VARCHAR(12) NOT NULL,
        note VARCHAR(500) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_flow_event_run (run_id, id),
        CONSTRAINT fk_flow_event_run FOREIGN KEY (run_id) REFERENCES flow_runs (id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE notifications (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NOT NULL,
        kind VARCHAR(20) NOT NULL,
        title VARCHAR(200) NOT NULL,
        body VARCHAR(500) NULL,
        link VARCHAR(200) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        read_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_notice_user (company_id, user_id, read_at, id),
        CONSTRAINT fk_notice_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ['notifications', 'flow_events', 'flow_ccs', 'work_items', 'flow_steps', 'flow_runs', 'flow_definitions']) await q.query(`DROP TABLE IF EXISTS ${t}`);
  }
}
