import { MigrationInterface, QueryRunner } from 'typeorm';

/** 表单草稿（旧系统 form_drafts）：每人每个草稿标识一份，换电脑也能接着填。 */
export class FormDrafts1739000000000 implements MigrationInterface {
  name = 'FormDrafts1739000000000';
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE form_drafts (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      draft_key VARCHAR(190) NOT NULL,
      module_key VARCHAR(80) NOT NULL,
      title VARCHAR(200) NOT NULL DEFAULT '',
      source_record_id VARCHAR(40) NULL,
      payload JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_form_draft (company_id, user_id, draft_key),
      KEY idx_form_draft_user (company_id, user_id, module_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner) {
    const [r] = await q.query('SELECT COUNT(*) n FROM form_drafts');
    if (Number(r.n)) throw new Error('已有草稿数据，不允许删除表；请先恢复迁前备份');
    await q.query('DROP TABLE form_drafts');
  }
}
