import { MigrationInterface, QueryRunner } from 'typeorm';

/** 人事管理·招聘：招聘二维码、求职者登记表、跟进/打印记录。只建结构，不放数据。 */
export class Recruitment1796000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE recruit_invites (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, company_id INT UNSIGNED NOT NULL,
      label VARCHAR(60) NOT NULL, channel VARCHAR(40) NULL,
      token_hash CHAR(64) NOT NULL, token_enc VARCHAR(400) NOT NULL,
      created_by INT UNSIGNED NOT NULL, revoked_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_recruit_invite_token (token_hash), KEY idx_recruit_invite_company (company_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await q.query(`CREATE TABLE recruit_applications (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, company_id INT UNSIGNED NOT NULL, invite_id INT UNSIGNED NOT NULL,
      request_key CHAR(36) NOT NULL, source_mode VARCHAR(10) NOT NULL,
      name VARCHAR(50) NOT NULL, gender VARCHAR(4) NOT NULL, ethnicity VARCHAR(20) NULL, birth_date DATE NOT NULL, marital VARCHAR(8) NULL,
      education VARCHAR(16) NOT NULL, school VARCHAR(100) NULL, graduation_date VARCHAR(10) NULL, expected_salary VARCHAR(40) NULL,
      id_no_enc VARCHAR(400) NOT NULL, id_no_masked VARCHAR(30) NOT NULL, phone VARCHAR(20) NOT NULL,
      education_json JSON NOT NULL, work_json JSON NOT NULL, achievements TEXT NULL, self_evaluation TEXT NULL, source_channel VARCHAR(40) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'submitted', handler_id INT UNSIGNED NULL, handled_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_recruit_app_request (company_id, request_key), KEY idx_recruit_app_company (company_id, id),
      KEY idx_recruit_app_phone (company_id, phone), KEY idx_recruit_app_handler (company_id, handler_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await q.query(`CREATE TABLE recruit_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, company_id INT UNSIGNED NOT NULL, application_id INT UNSIGNED NOT NULL,
      event_type VARCHAR(20) NOT NULL, actor_id INT UNSIGNED NULL, detail_json JSON NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_recruit_event_app (company_id, application_id, id), KEY idx_recruit_event_actor (company_id, actor_id, event_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner) {
    const [r] = await q.query('SELECT (SELECT COUNT(*) FROM recruit_applications) n');
    if (Number(r.n)) throw new Error('已有求职者登记数据，不能回退结构');
    await q.query('DROP TABLE recruit_events');
    await q.query('DROP TABLE recruit_applications');
    await q.query('DROP TABLE recruit_invites');
  }
}
