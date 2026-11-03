import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnrollmentWorkforce1773000000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query("ALTER TABLE staff_enrollment_invites ADD employment_type VARCHAR(16) NOT NULL DEFAULT 'regular', ADD contract_start_date DATE NULL, ADD contract_end_date DATE NULL");
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE staff_enrollment_invites DROP COLUMN contract_end_date, DROP COLUMN contract_start_date, DROP COLUMN employment_type');
  }
}
