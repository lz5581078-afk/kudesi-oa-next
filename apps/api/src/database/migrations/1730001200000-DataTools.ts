import { MigrationInterface, QueryRunner } from 'typeorm';

/** 成本历史快照、API 密钥、主数据重置快照。 */
export class DataTools1730001200000 implements MigrationInterface {
  name = 'DataTools1730001200000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE finance_cost_snapshots (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        bundle_id INT UNSIGNED NOT NULL,
        code VARCHAR(120) NOT NULL,
        name VARCHAR(300) NOT NULL,
        revision INT UNSIGNED NOT NULL,
        pre_ship_cost_cents BIGINT NULL,
        weight_g DECIMAL(14,2) NULL,
        freight_cents BIGINT NULL,
        margin_percent DECIMAL(9,4) NULL,
        min_price_cents BIGINT NULL,
        reason VARCHAR(200) NOT NULL DEFAULT '',
        actor_id INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_cost_snap_bundle (company_id, bundle_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query(`
      CREATE TABLE finance_api_keys (
        id CHAR(36) NOT NULL,
        company_id INT UNSIGNED NOT NULL,
        name VARCHAR(100) NOT NULL,
        scope VARCHAR(40) NOT NULL,
        key_hash CHAR(64) NOT NULL,
        created_by INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME NULL,
        revoked_by INT UNSIGNED NULL,
        revoked_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_api_keys_company (company_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query(`
      CREATE TABLE finance_master_snapshots (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        operation VARCHAR(16) NOT NULL,
        label VARCHAR(200) NOT NULL,
        scope_json JSON NOT NULL,
        snapshot_json LONGTEXT NOT NULL,
        row_count INT UNSIGNED NOT NULL,
        created_by INT UNSIGNED NULL,
        restored_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_master_snap_company (company_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS finance_master_snapshots');
    await q.query('DROP TABLE IF EXISTS finance_api_keys');
    await q.query('DROP TABLE IF EXISTS finance_cost_snapshots');
  }
}
