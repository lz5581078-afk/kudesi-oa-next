import { MigrationInterface, QueryRunner } from 'typeorm';

/** New invitation codes have no time limit; historical expiration dates remain unchanged. */
export class EnrollmentPermanent1775000000000 implements MigrationInterface {
  name = 'EnrollmentPermanent1775000000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE staff_enrollment_invites MODIFY expires_at datetime NULL');
  }
  async down(q: QueryRunner): Promise<void> {
    // MySQL refuses this rollback while permanent codes exist rather than inventing expiration dates.
    await q.query('ALTER TABLE staff_enrollment_invites MODIFY expires_at datetime NOT NULL');
  }
}
