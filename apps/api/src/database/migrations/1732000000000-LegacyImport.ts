import { MigrationInterface, QueryRunner } from 'typeorm';

export class LegacyImport1732000000000 implements MigrationInterface {
  name = 'LegacyImport1732000000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE users MODIFY account varchar(64) NULL, MODIFY password_hash varchar(255) NOT NULL');
    await q.query(`CREATE TABLE legacy_import_links (
      id int unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
      source_system varchar(40) NOT NULL,
      source_company_id int unsigned NOT NULL,
      company_id int unsigned NOT NULL,
      source_key varchar(255) NOT NULL,
      target_type varchar(64) NOT NULL,
      target_id int unsigned NOT NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_legacy_import_source (source_system,source_company_id,company_id,source_key),
      KEY idx_legacy_import_target (company_id,target_type,target_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner): Promise<void> {
    const [r] = await q.query('SELECT COUNT(*) n FROM users WHERE account IS NULL OR CHAR_LENGTH(password_hash)>100');
    const [links] = await q.query('SELECT COUNT(*) n FROM legacy_import_links');
    if (Number(r.n) || Number(links.n)) throw new Error('已有迁入人员或来源对照，不能缩短凭据/清除账本；请先恢复迁前备份');
    await q.query('DROP TABLE legacy_import_links');
    await q.query('ALTER TABLE users MODIFY account varchar(64) NOT NULL, MODIFY password_hash varchar(100) NOT NULL');
  }
}
