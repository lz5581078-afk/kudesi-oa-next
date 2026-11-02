import { MigrationInterface, QueryRunner } from 'typeorm';

export class LiveNotifications1767000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE live_notification_settings (
      company_id INT UNSIGNED NOT NULL PRIMARY KEY,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      digest_enabled TINYINT(1) NOT NULL DEFAULT 0,
      digest_hour TINYINT UNSIGNED NOT NULL DEFAULT 9,
      business_recipients JSON NOT NULL, system_recipients JSON NOT NULL,
      activated_at DATETIME NOT NULL, updated_by INT UNSIGNED NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await q.query(`CREATE TABLE live_notification_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id INT UNSIGNED NOT NULL, event_key VARCHAR(100) NOT NULL, user_id INT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_live_notice (company_id,event_key,user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await q.query(`CREATE TABLE live_notification_health (
      company_id INT UNSIGNED NOT NULL, health_key VARCHAR(100) NOT NULL,
      failures INT UNSIGNED NOT NULL DEFAULT 0, first_failed_at DATETIME NULL, updated_at DATETIME NOT NULL,
      PRIMARY KEY(company_id,health_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner) {
    const [row] = await q.query('SELECT (SELECT COUNT(*) FROM live_notification_events) + (SELECT COUNT(*) FROM live_notification_settings) + (SELECT COUNT(*) FROM live_notification_health) n');
    if (Number(row.n)) throw new Error('已有直播通知记录，不能回退');
    await q.query('DROP TABLE live_notification_health');
    await q.query('DROP TABLE live_notification_events');
    await q.query('DROP TABLE live_notification_settings');
  }
}
