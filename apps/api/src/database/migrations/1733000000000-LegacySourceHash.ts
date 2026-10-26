import { MigrationInterface, QueryRunner } from 'typeorm';
export class LegacySourceHash1733000000000 implements MigrationInterface {
  name = 'LegacySourceHash1733000000000';
  async up(q: QueryRunner) { await q.query("ALTER TABLE legacy_import_links ADD source_hash char(64) NOT NULL DEFAULT ''"); }
  async down(q: QueryRunner) {
    const [r] = await q.query('SELECT COUNT(*) n FROM legacy_import_links');
    if (Number(r.n)) throw new Error('已有迁入来源指纹，不允许移除；请先恢复迁前备份');
    await q.query('ALTER TABLE legacy_import_links DROP source_hash');
  }
}
