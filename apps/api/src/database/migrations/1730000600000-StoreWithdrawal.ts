import { MigrationInterface, QueryRunner } from 'typeorm';

/** 店铺提现：提现单增加店铺和平台流水号；店铺登录管理（授权电脑、托管店铺、打开请求、操作日志）。 */
export class StoreWithdrawal1730000600000 implements MigrationInterface {
  name = 'StoreWithdrawal1730000600000';

  public async up(q: QueryRunner): Promise<void> {
    const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await q.query(`ALTER TABLE finance_documents
      ADD COLUMN store_id INT UNSIGNED NULL AFTER warehouse_id,
      ADD COLUMN ref_no VARCHAR(80) NULL AFTER store_id,
      ADD UNIQUE KEY uq_fin_doc_ref (company_id, doc_type, ref_no),
      ADD KEY idx_fin_doc_store (company_id, store_id)`);
    await q.query(`CREATE TABLE session_devices (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        device_no CHAR(12) NOT NULL,
        name VARCHAR(80) NOT NULL,
        os VARCHAR(60) NULL,
        agent_version VARCHAR(30) NULL,
        token_hash CHAR(64) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'active',
        last_seen_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_session_device_no (device_no),
        UNIQUE KEY uq_session_device_token (token_hash),
        KEY idx_session_device_company (company_id, status),
        CONSTRAINT fk_session_device_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
    await q.query(`CREATE TABLE session_bind_codes (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        code_hash CHAR(64) NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME NULL,
        created_by INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_session_bind_code (code_hash),
        CONSTRAINT fk_session_bind_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
    await q.query(`CREATE TABLE session_shops (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        workspace VARCHAR(30) NOT NULL DEFAULT 'finance_withdrawal',
        store_id INT UNSIGNED NOT NULL,
        device_id INT UNSIGNED NULL,
        login_account VARCHAR(100) NULL,
        login_password_enc TEXT NULL,
        auto_login TINYINT(1) NOT NULL DEFAULT 0,
        login_state VARCHAR(10) NOT NULL DEFAULT 'none',
        last_verified_at DATETIME NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'active',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_session_shop (company_id, workspace, store_id),
        KEY idx_session_shop_device (device_id),
        CONSTRAINT fk_session_shop_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
    await q.query(`CREATE TABLE session_open_requests (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        shop_id INT UNSIGNED NOT NULL,
        device_id INT UNSIGNED NOT NULL,
        kind VARCHAR(8) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'pending',
        error_code VARCHAR(40) NULL,
        error_text VARCHAR(300) NULL,
        requested_by INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        claimed_at DATETIME NULL,
        finished_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_session_req_shop (company_id, shop_id, status),
        KEY idx_session_req_device (device_id, status),
        CONSTRAINT fk_session_req_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
    await q.query(`CREATE TABLE session_audit_logs (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        summary VARCHAR(500) NOT NULL,
        actor_id INT UNSIGNED NULL,
        device_id INT UNSIGNED NULL,
        store_id INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_session_audit (company_id, id),
        CONSTRAINT fk_session_audit_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ['session_audit_logs', 'session_open_requests', 'session_shops', 'session_bind_codes', 'session_devices']) await q.query(`DROP TABLE IF EXISTS ${t}`);
    await q.query('ALTER TABLE finance_documents DROP KEY uq_fin_doc_ref, DROP KEY idx_fin_doc_store, DROP COLUMN store_id, DROP COLUMN ref_no');
  }
}
