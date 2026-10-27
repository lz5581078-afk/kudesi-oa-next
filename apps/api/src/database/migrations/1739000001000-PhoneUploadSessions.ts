import { MigrationInterface, QueryRunner } from 'typeorm';

/** 手机扫码上传的临时会话：只存令牌的哈希，短期有效、限次数、只能传到指定资料类型的指定字段。 */
export class PhoneUploadSessions1739000001000 implements MigrationInterface {
  name = 'PhoneUploadSessions1739000001000';
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE phone_upload_sessions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      company_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      resource_type VARCHAR(40) NOT NULL,
      field_key VARCHAR(48) NOT NULL,
      max_uploads TINYINT UNSIGNED NOT NULL,
      upload_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
      file_ids JSON NOT NULL,
      expires_at DATETIME NOT NULL,
      scanned_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_phone_upload_token (token_hash),
      KEY idx_phone_upload_user (company_id, user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner) {
    await q.query('DROP TABLE phone_upload_sessions');
  }
}
