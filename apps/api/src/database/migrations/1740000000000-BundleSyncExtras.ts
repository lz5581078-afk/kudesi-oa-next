import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 组合装同步的补充表（旧系统同名功能）：
 *  - bundle_archive_jobs：归档任务（OA 已归档，聚水潭禁用结果可跟踪、可复查）
 *  - bundle_price_logs：组合基本售价同步日志
 *  - jst_category_links / jst_category_runs：聚水潭商品分类同步的关联关系与同步记录
 *  - finance_cost_snapshots.event_type：成本历史的事件类型（验证发布/维护售价/来源值变化…）
 */
export class BundleSyncExtras1740000000000 implements MigrationInterface {
  name = 'BundleSyncExtras1740000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE bundle_archive_jobs (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        bundle_id INT UNSIGNED NOT NULL,
        actor_id INT UNSIGNED NOT NULL,
        reason VARCHAR(500) NOT NULL,
        code VARCHAR(120) NOT NULL,
        name VARCHAR(300) NOT NULL DEFAULT '',
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        message VARCHAR(800) NULL,
        outbox_job_id INT UNSIGNED NULL,
        target_key VARCHAR(64) NULL,
        request_json JSON NOT NULL,
        job_json JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_archive_job (company_id, bundle_id),
        KEY idx_archive_status (company_id, status, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query(`
      CREATE TABLE bundle_price_logs (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        bundle_id INT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL,
        price_cents BIGINT NULL,
        message VARCHAR(800) NULL,
        outbox_job_id INT UNSIGNED NULL,
        evidence_json JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_price_log (company_id, bundle_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query(`
      CREATE TABLE jst_category_links (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        category_id INT UNSIGNED NOT NULL,
        target_key VARCHAR(64) NOT NULL,
        remote_id VARCHAR(40) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'linked',
        local_json JSON NOT NULL,
        remote_json JSON NULL,
        pending_json JSON NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_category_link (company_id, target_key, category_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query(`
      CREATE TABLE jst_category_runs (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        mode VARCHAR(16) NOT NULL,
        actor_id INT UNSIGNED NULL,
        status VARCHAR(16) NOT NULL,
        message VARCHAR(800) NULL,
        details_json JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_category_run (company_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query("ALTER TABLE finance_cost_snapshots ADD COLUMN event_type VARCHAR(24) NOT NULL DEFAULT 'manual' AFTER reason");
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_cost_snapshots DROP COLUMN event_type');
    await q.query('DROP TABLE IF EXISTS jst_category_runs');
    await q.query('DROP TABLE IF EXISTS jst_category_links');
    await q.query('DROP TABLE IF EXISTS bundle_price_logs');
    await q.query('DROP TABLE IF EXISTS bundle_archive_jobs');
  }
}
