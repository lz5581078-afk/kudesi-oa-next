import { MigrationInterface, QueryRunner } from 'typeorm';
export class FeishuIdentity1756000000000 implements MigrationInterface {
  name = 'FeishuIdentity1756000000000';
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE feishu_identities (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
      app_id VARCHAR(100) NOT NULL, tenant_key VARCHAR(100) NOT NULL, open_id VARCHAR(150) NOT NULL, union_id VARCHAR(150) NULL,
      bound_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_feishu_subject(app_id,tenant_key,open_id), UNIQUE KEY uq_feishu_user(company_id,user_id,app_id),
      FOREIGN KEY (company_id) REFERENCES companies(id), FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await q.query(`CREATE TABLE feishu_oauth_states (
      state_hash CHAR(64) NOT NULL PRIMARY KEY, browser_hash CHAR(64) NOT NULL,
      company_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NULL, app_id VARCHAR(100) NOT NULL,
      purpose VARCHAR(10) NOT NULL, redirect_uri VARCHAR(300) NOT NULL,
      expires_at DATETIME NOT NULL, consumed_at DATETIME NULL,
      INDEX idx_feishu_expiry(expires_at), FOREIGN KEY (company_id) REFERENCES companies(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner) { await q.query('DROP TABLE feishu_oauth_states'); await q.query('DROP TABLE feishu_identities'); }
}
