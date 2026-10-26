import { MigrationInterface, QueryRunner } from 'typeorm';

/** 出站队列：所有对外写入（先是聚水潭）都排进来，由单一 worker 在总开关打开时发送。总开关默认关。 */
export class Outbox1730001300000 implements MigrationInterface {
  name = 'Outbox1730001300000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE outbox_jobs (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        channel VARCHAR(24) NOT NULL,
        kind VARCHAR(32) NOT NULL,
        resource_type VARCHAR(32) NOT NULL,
        resource_id INT UNSIGNED NOT NULL,
        idempotency_key VARCHAR(120) NOT NULL,
        payload_json JSON NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'pending',
        attempts INT UNSIGNED NOT NULL DEFAULT 0,
        next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_error VARCHAR(500) NULL,
        created_by INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        done_at DATETIME NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_outbox_idem (company_id, idempotency_key),
        KEY idx_outbox_pick (company_id, channel, status, next_attempt_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query(`
      CREATE TABLE outbox_switches (
        company_id INT UNSIGNED NOT NULL,
        channel VARCHAR(24) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        note VARCHAR(200) NULL,
        updated_by INT UNSIGNED NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (company_id, channel)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS outbox_switches');
    await q.query('DROP TABLE IF EXISTS outbox_jobs');
  }
}
