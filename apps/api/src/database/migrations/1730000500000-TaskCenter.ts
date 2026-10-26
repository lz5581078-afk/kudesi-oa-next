import { MigrationInterface, QueryRunner } from 'typeorm';

/** 任务中心：待办表增加任务字段；新增周期任务表。 */
export class TaskCenter1730000500000 implements MigrationInterface {
  name = 'TaskCenter1730000500000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE work_items
      ADD COLUMN description VARCHAR(1000) NULL AFTER title,
      ADD COLUMN created_by INT UNSIGNED NULL AFTER assignee_id,
      ADD COLUMN routine_id INT UNSIGNED NULL AFTER created_by,
      ADD COLUMN schedule_key VARCHAR(80) NULL AFTER routine_id,
      ADD COLUMN done_note VARCHAR(500) NULL AFTER finished_at,
      ADD UNIQUE KEY uq_work_schedule (company_id, schedule_key),
      ADD KEY idx_work_creator (company_id, created_by, status)`);
    await q.query(`
      CREATE TABLE task_routines (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        title VARCHAR(150) NOT NULL,
        description VARCHAR(1000) NULL,
        assignee_id INT UNSIGNED NOT NULL,
        frequency VARCHAR(8) NOT NULL,
        weekday TINYINT UNSIGNED NULL,
        month_day TINYINT UNSIGNED NULL,
        due_days TINYINT UNSIGNED NOT NULL DEFAULT 1,
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_routine_company (company_id, active),
        CONSTRAINT fk_routine_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS task_routines');
    await q.query(`ALTER TABLE work_items DROP KEY uq_work_schedule, DROP KEY idx_work_creator, DROP COLUMN description, DROP COLUMN created_by, DROP COLUMN routine_id, DROP COLUMN schedule_key, DROP COLUMN done_note`);
  }
}
