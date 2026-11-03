import { MigrationInterface, QueryRunner } from 'typeorm';
export class WorkforceLoginSecrets1774000000000 implements MigrationInterface {
  async up(q:QueryRunner):Promise<void> {
    await q.query(`CREATE TABLE workforce_login_secrets (company_id INT NOT NULL, user_id INT NOT NULL, password_cipher TEXT NOT NULL, password_hash_snapshot VARCHAR(255) NOT NULL, updated_by INT NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY(company_id,user_id)) ENGINE=InnoDB`);
  }
  async down(q:QueryRunner):Promise<void> { await q.query('DROP TABLE workforce_login_secrets'); }
}
