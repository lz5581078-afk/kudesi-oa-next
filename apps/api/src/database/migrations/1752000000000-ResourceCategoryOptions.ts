import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 公司级资料分类选项（列表页签“管理分类”）：系统分类的改名/排序、公司自建分类、隐藏。
 * 只新增一张表，向后兼容：没有行时一切沿用代码里的选项；不含种子数据。
 */
export class ResourceCategoryOptions1752000000000 implements MigrationInterface {
  name = 'ResourceCategoryOptions1752000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE resource_category_options (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        resource_type VARCHAR(64) NOT NULL,
        field_key VARCHAR(48) NOT NULL,
        value VARCHAR(64) NOT NULL,
        label VARCHAR(60) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        hidden TINYINT(1) NOT NULL DEFAULT 0,
        custom TINYINT(1) NOT NULL DEFAULT 0,
        created_by INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_by INT UNSIGNED NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_resource_category (company_id, resource_type, field_key, value)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS resource_category_options');
  }
}
