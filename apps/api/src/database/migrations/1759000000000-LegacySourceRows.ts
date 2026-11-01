import { MigrationInterface, QueryRunner } from 'typeorm';

/** Immutable encrypted provenance; business conversion never replaces source history. */
export class LegacySourceRows1759000000000 implements MigrationInterface {
  name = 'LegacySourceRows1759000000000';
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE legacy_source_rows (
      id bigint unsigned NOT NULL AUTO_INCREMENT,
      company_id int unsigned NOT NULL,
      source_system varchar(40) NOT NULL,
      source_company_id bigint unsigned NOT NULL,
      source_table varchar(80) NOT NULL,
      source_key varchar(200) COLLATE utf8mb4_bin NOT NULL,
      source_hash char(64) NOT NULL,
      raw_encrypted longtext NOT NULL,
      imported_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_legacy_source_row (company_id,source_system,source_company_id,source_table,source_key),
      CONSTRAINT fk_legacy_source_company FOREIGN KEY (company_id) REFERENCES companies(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  async down(q: QueryRunner) {
    const [r] = await q.query('SELECT COUNT(*) n FROM legacy_source_rows');
    if (Number(r.n)) throw new Error('已有旧站原始记录，禁止通过回退结构删除；请使用核对后的备份恢复');
    await q.query('DROP TABLE legacy_source_rows');
  }
}
