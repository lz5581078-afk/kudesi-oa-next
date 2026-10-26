import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0002 资料表：通用资源记录、关联、变更日志。
 * 资料的字段定义在 packages/shared/src/resources.ts，字段值放 data(JSON)，
 * 状态、标题、唯一键、搜索文本单独成列，便于过滤、唯一约束和索引。
 */
export class ResourceTables1730000100000 implements MigrationInterface {
  name = 'ResourceTables1730000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

    await queryRunner.query(`
      CREATE TABLE resource_records (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        type VARCHAR(32) NOT NULL,
        title VARCHAR(200) NOT NULL,
        unique_key VARCHAR(200) NULL,
        status VARCHAR(24) NOT NULL,
        status_reason VARCHAR(500) NULL,
        search_text VARCHAR(1500) NOT NULL DEFAULT '',
        data JSON NOT NULL,
        secrets TEXT NULL,
        created_by INT UNSIGNED NULL,
        updated_by INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_resource_unique (company_id, type, unique_key),
        KEY idx_resource_list (company_id, type, status, id),
        KEY idx_resource_title (company_id, type, title),
        CONSTRAINT fk_resource_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);

    await queryRunner.query(`
      CREATE TABLE resource_links (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        source_type VARCHAR(32) NOT NULL,
        source_id INT UNSIGNED NOT NULL,
        relation VARCHAR(48) NOT NULL,
        target_type VARCHAR(32) NOT NULL,
        target_id INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_resource_link (company_id, source_id, relation),
        KEY idx_resource_link_target (company_id, target_type, target_id),
        CONSTRAINT fk_resource_link_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);

    await queryRunner.query(`
      CREATE TABLE resource_change_logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        resource_type VARCHAR(32) NOT NULL,
        resource_id INT UNSIGNED NOT NULL,
        action VARCHAR(24) NOT NULL,
        actor_id INT UNSIGNED NULL,
        before_json JSON NULL,
        after_json JSON NULL,
        note VARCHAR(500) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_resource_log (company_id, resource_type, resource_id, id),
        KEY idx_resource_log_time (company_id, created_at),
        CONSTRAINT fk_resource_log_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS resource_change_logs');
    await queryRunner.query('DROP TABLE IF EXISTS resource_links');
    await queryRunner.query('DROP TABLE IF EXISTS resource_records');
  }
}
