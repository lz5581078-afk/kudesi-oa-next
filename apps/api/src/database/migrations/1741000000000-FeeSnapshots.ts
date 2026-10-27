import { MigrationInterface, QueryRunner } from 'typeorm';

/** 费用档案存档表（旧系统“存为历史包”）：把费用类别 + 费用项目整份存成命名快照，可查看、恢复、删除；恢复前自动再存一份。 */
export class FeeSnapshots1741000000000 implements MigrationInterface {
  name = 'FeeSnapshots1741000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE finance_fee_snapshots (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL,
        remark VARCHAR(500) NULL,
        auto TINYINT(1) NOT NULL DEFAULT 0,
        category_count INT UNSIGNED NOT NULL DEFAULT 0,
        item_count INT UNSIGNED NOT NULL DEFAULT 0,
        snapshot_json LONGTEXT NOT NULL,
        created_by INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        restored_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_fee_snapshot (company_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS finance_fee_snapshots');
  }
}
