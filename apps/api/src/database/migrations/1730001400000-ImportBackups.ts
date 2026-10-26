import { MigrationInterface, QueryRunner } from 'typeorm';

/** 资料导入前的整类快照：每个公司每类资料保留最近 5 份，可一键恢复。 */
export class ImportBackups1730001400000 implements MigrationInterface {
  name = 'ImportBackups1730001400000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE resource_import_backups (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        resource_type VARCHAR(32) NOT NULL,
        record_count INT UNSIGNED NOT NULL DEFAULT 0,
        snapshot_json LONGTEXT NOT NULL,
        created_by INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        restored_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_import_backup (company_id, resource_type, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS resource_import_backups');
  }
}
