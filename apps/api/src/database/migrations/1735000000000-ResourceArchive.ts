import { MigrationInterface, QueryRunner } from 'typeorm';
/** 资料软归档（旧系统同款）：归档时间/操作人/原因/归档前状态，归档的资料不物理删除，可恢复。 */
export class ResourceArchive1735000000000 implements MigrationInterface {
  name = 'ResourceArchive1735000000000';
  async up(q: QueryRunner) {
    await q.query(
      'ALTER TABLE resource_records ADD archived_at datetime NULL, ADD archived_by int unsigned NULL, ADD archive_reason varchar(500) NULL, ADD archived_from_status varchar(24) NULL',
    );
    await q.query('CREATE INDEX idx_resource_archive ON resource_records (company_id, type, archived_at)');
  }
  async down(q: QueryRunner) {
    const [r] = await q.query('SELECT COUNT(*) n FROM resource_records WHERE archived_at IS NOT NULL');
    if (Number(r.n)) throw new Error('已有归档资料，不允许移除归档字段；请先恢复迁前备份');
    await q.query('DROP INDEX idx_resource_archive ON resource_records');
    await q.query('ALTER TABLE resource_records DROP archived_at, DROP archived_by, DROP archive_reason, DROP archived_from_status');
  }
}
