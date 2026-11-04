import { MigrationInterface, QueryRunner } from 'typeorm';
export const DESKTOP_AFTER_SALES_TABLES = ['desktop_after_sales', 'desktop_after_sales_events'] as const;
export class DesktopAfterSales1791000000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE desktop_after_sales (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id INT UNSIGNED NOT NULL, store_id INT UNSIGNED NOT NULL,
      source_company VARCHAR(100) NOT NULL, after_sale_id VARCHAR(40) NOT NULL,
      internal_order_id VARCHAR(40) NOT NULL, snapshot_enc MEDIUMTEXT NOT NULL,
      progress_enc TEXT NOT NULL, owner_id INT UNSIGNED NULL, next_at DATETIME NULL,
      version INT UNSIGNED NOT NULL DEFAULT 1, attachments JSON NOT NULL,
      created_by INT UNSIGNED NOT NULL, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_desktop_sale (company_id, source_company, after_sale_id),
      KEY idx_desktop_follow (company_id, next_at, id), KEY idx_desktop_store (company_id,store_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await q.query(`CREATE TABLE desktop_after_sales_events (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, company_id INT UNSIGNED NOT NULL,
      sale_id INT UNSIGNED NOT NULL, kind VARCHAR(24) NOT NULL,
      content_enc MEDIUMTEXT NOT NULL, actor_id INT UNSIGNED NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_desktop_events (company_id, sale_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE desktop_after_sales_events');
    await q.query('DROP TABLE desktop_after_sales');
  }
}
