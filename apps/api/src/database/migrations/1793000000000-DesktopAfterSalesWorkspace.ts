import {MigrationInterface,QueryRunner} from 'typeorm';
export const DESKTOP_WORKSPACE_TABLES=['desktop_after_sales_sources','desktop_after_sales_grants'] as const;
export class DesktopAfterSalesWorkspace1793000000000 implements MigrationInterface {
 async up(q:QueryRunner):Promise<void>{
  await q.query(`ALTER TABLE desktop_after_sales MODIFY store_id INT UNSIGNED NULL,
   ADD priority TINYINT UNSIGNED NOT NULL DEFAULT 0, ADD row_color VARCHAR(7) NULL,
   ADD report_enc MEDIUMTEXT NULL, ADD application_at DATETIME NULL,
   ADD source_seen_at DATETIME(3) NULL, ADD flow_case_id INT UNSIGNED NULL,
   ADD KEY idx_desktop_application(company_id,application_at,id)`);
  await q.query(`CREATE TABLE desktop_after_sales_sources(
   id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, company_id INT UNSIGNED NOT NULL,
   source_company VARCHAR(100) NOT NULL, enabled TINYINT NOT NULL DEFAULT 0,
   interval_seconds INT UNSIGNED NOT NULL DEFAULT 60, last_success_at DATETIME(3) NULL,
   watermark_at DATETIME(3) NULL, last_failure_at DATETIME(3) NULL, last_error_enc TEXT NULL,
   last_client_seen_at DATETIME(3) NULL,
   next_query_at DATETIME(3) NULL, lease_client VARCHAR(36) NULL, lease_user_id INT UNSIGNED NULL,
   lease_hash CHAR(64) NULL, lease_started_at DATETIME(3) NULL, lease_until DATETIME(3) NULL,
   query_from DATETIME(3) NULL, query_until DATETIME(3) NULL, next_page INT UNSIGNED NOT NULL DEFAULT 1,
   failure_count INT UNSIGNED NOT NULL DEFAULT 0, collected_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
   created_by INT UNSIGNED NOT NULL, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
   UNIQUE KEY uq_desktop_source(company_id,source_company)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await q.query(`CREATE TABLE desktop_after_sales_grants(
   company_id INT UNSIGNED NOT NULL, sale_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
   granted_by INT UNSIGNED NOT NULL, can_write TINYINT NOT NULL DEFAULT 0,
   created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
   PRIMARY KEY(company_id,sale_id,user_id), KEY idx_desktop_shared(company_id,user_id,sale_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
 }
 async down(q:QueryRunner):Promise<void>{
  const [record]=await q.query('SELECT COUNT(*) AS n FROM desktop_after_sales WHERE report_enc IS NOT NULL OR priority<>0 OR row_color IS NOT NULL OR flow_case_id IS NOT NULL');if(Number(record.n))throw new Error('售后处理资料已有数据，禁止直接回退');
  for(const t of DESKTOP_WORKSPACE_TABLES){const [r]=await q.query(`SELECT COUNT(*) AS n FROM ${t}`);if(Number(r.n))throw new Error('售后协作或采集状态已有数据，请核对备份后回退');}
  await q.query('DROP TABLE desktop_after_sales_grants');await q.query('DROP TABLE desktop_after_sales_sources');
  await q.query(`ALTER TABLE desktop_after_sales DROP INDEX idx_desktop_application,
   DROP COLUMN priority,DROP COLUMN row_color,DROP COLUMN report_enc,DROP COLUMN application_at,
   DROP COLUMN source_seen_at,DROP COLUMN flow_case_id`);
 }
}
