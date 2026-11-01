import { MigrationInterface, QueryRunner } from 'typeorm';

export class SessionMaintenanceParity1758000000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE session_devices ADD remark VARCHAR(80) NULL');
    await q.query('ALTER TABLE session_audit_logs ADD workspace VARCHAR(30) NULL, ADD INDEX idx_session_audit_workspace (company_id, workspace, id)');
    await q.query('ALTER TABLE session_open_requests ADD progress_percent SMALLINT UNSIGNED NULL, ADD progress_step VARCHAR(40) NULL');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE session_open_requests DROP progress_percent, DROP progress_step');
    await q.query('ALTER TABLE session_audit_logs DROP INDEX idx_session_audit_workspace, DROP workspace');
    await q.query('ALTER TABLE session_devices DROP remark');
  }
}
