import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 任务中心补监督人、复核、异常提交、反馈模板、延期申请（旧任务系统的逻辑）。
 * 只加列和新表，旧数据不动：旧待办 supervisor_id 为空、requires_review=0，行为和以前完全一样。
 */
export class TaskSupervision1745000000000 implements MigrationInterface {
  name = 'TaskSupervision1745000000000';

  public async up(q: QueryRunner): Promise<void> {
    // 提交时间、复核意见沿用 1747000000000 已有的 submitted_at / review_note，这里不重复加
    await q.query(`ALTER TABLE work_items
      ADD COLUMN supervisor_id INT UNSIGNED NULL,
      ADD COLUMN requires_review TINYINT(1) NOT NULL DEFAULT 0,
      ADD COLUMN feedback_preset VARCHAR(30) NULL,
      ADD COLUMN completion_standard VARCHAR(500) NULL,
      ADD COLUMN submit_payload JSON NULL,
      ADD COLUMN is_abnormal TINYINT(1) NOT NULL DEFAULT 0,
      ADD KEY idx_work_supervisor (company_id, supervisor_id, status)`);
    await q.query(`ALTER TABLE task_routines
      ADD COLUMN supervisor_id INT UNSIGNED NULL,
      ADD COLUMN requires_review TINYINT(1) NOT NULL DEFAULT 0,
      ADD COLUMN feedback_preset VARCHAR(30) NULL,
      ADD COLUMN completion_standard VARCHAR(500) NULL`);
    await q.query(`
      CREATE TABLE task_delay_requests (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        work_item_id INT UNSIGNED NOT NULL,
        requester_id INT UNSIGNED NOT NULL,
        approver_id INT UNSIGNED NOT NULL,
        old_due_at DATETIME NULL,
        requested_due_at DATETIME NOT NULL,
        reason VARCHAR(500) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'pending',
        approval_comment VARCHAR(500) NULL,
        decided_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_delay_item (company_id, work_item_id, status),
        KEY idx_delay_approver (company_id, approver_id, status),
        CONSTRAINT fk_delay_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS task_delay_requests');
    await q.query('ALTER TABLE task_routines DROP COLUMN completion_standard, DROP COLUMN feedback_preset, DROP COLUMN requires_review, DROP COLUMN supervisor_id');
    await q.query('ALTER TABLE work_items DROP KEY idx_work_supervisor, DROP COLUMN is_abnormal, DROP COLUMN submit_payload, DROP COLUMN completion_standard, DROP COLUMN feedback_preset, DROP COLUMN requires_review, DROP COLUMN supervisor_id');
  }
}
