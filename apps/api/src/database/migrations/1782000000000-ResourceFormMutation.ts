import { MigrationInterface, QueryRunner } from 'typeorm';

/** 通用资料整组保存的重试标识；不存表单内容，不修改已有业务记录。 */
export class ResourceFormMutation1782000000000 implements MigrationInterface {
  name = 'ResourceFormMutation1782000000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE resource_form_mutations (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id INT UNSIGNED NOT NULL, actor_id INT UNSIGNED NOT NULL,
      resource_type VARCHAR(64) NOT NULL, request_key CHAR(36) NOT NULL,
      request_hash CHAR(64) NOT NULL, record_id INT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_resource_form_request (company_id, request_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner): Promise<void> { await q.query('DROP TABLE resource_form_mutations'); }
}
