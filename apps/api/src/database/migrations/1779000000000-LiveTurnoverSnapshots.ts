import { MigrationInterface, QueryRunner } from 'typeorm';

export class LiveTurnoverSnapshots1779000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE live_turnover_snapshots (
      company_id INT UNSIGNED NOT NULL, session_id INT UNSIGNED NOT NULL,
      payload_json JSON NULL, locked_at DATETIME NULL,
      next_refresh_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00',
      lease_token VARCHAR(36) NULL, lease_until DATETIME NULL,
      last_error VARCHAR(500) NULL, failures INT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (company_id,session_id), KEY idx_turnover_due (locked_at,next_refresh_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner) {
    const [r] = await q.query('SELECT COUNT(*) n FROM live_turnover_snapshots');
    if (Number(r.n)) throw new Error('已有营业额快照，不能回退');
    await q.query('DROP TABLE live_turnover_snapshots');
  }
}
