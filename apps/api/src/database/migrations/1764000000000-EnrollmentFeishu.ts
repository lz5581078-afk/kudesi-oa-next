import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnrollmentFeishu1764000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query('ALTER TABLE feishu_identities ADD COLUMN oa_notifications TINYINT(1) NOT NULL DEFAULT 0');
    await q.query('CREATE INDEX idx_audit_actor_action ON audit_logs(company_id,actor_id,action)');
  }
  async down(q: QueryRunner) {
    await q.query('DROP INDEX idx_audit_actor_action ON audit_logs');
    await q.query('ALTER TABLE feishu_identities DROP COLUMN oa_notifications');
  }
}
