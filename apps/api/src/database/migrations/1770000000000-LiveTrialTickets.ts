import { MigrationInterface, QueryRunner } from 'typeorm';

export class LiveTrialTickets1770000000000 implements MigrationInterface {
  async up(q:QueryRunner) {
    await q.query(`CREATE TABLE live_trial_tickets (
      token_hash CHAR(64) CHARACTER SET ascii PRIMARY KEY,
      company_id INT NOT NULL, issuer_id INT NOT NULL, payload JSON NOT NULL,
      expires_at DATETIME NOT NULL, session_id INT NULL, INDEX(company_id,session_id)
    ) ENGINE=InnoDB`);
  }
  async down(q:QueryRunner) { await q.query('DROP TABLE live_trial_tickets'); }
}
