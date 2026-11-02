import { MigrationInterface, QueryRunner } from 'typeorm';

export class StaffEnrollment1762000000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE staff_enrollment_invites (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id INT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      mode VARCHAR(12) NOT NULL,
      position_id INT UNSIGNED NULL,
      created_by INT UNSIGNED NOT NULL,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_staff_enrollment_token (token_hash),
      KEY idx_staff_enrollment_company (company_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  async down(q: QueryRunner): Promise<void> { await q.query('DROP TABLE staff_enrollment_invites'); }
}
