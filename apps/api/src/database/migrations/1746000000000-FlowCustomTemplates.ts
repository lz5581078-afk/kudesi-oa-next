import { MigrationInterface, QueryRunner } from 'typeorm';

/** 公司自建流程模板与节点模板；流程版本新增 schema_json（自建模板的表单结构随版本保存）。只加表加列。 */
export class FlowCustomTemplates1746000000000 implements MigrationInterface {
  name = 'FlowCustomTemplates1746000000000';

  public async up(q: QueryRunner): Promise<void> {
    const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await q.query(`
      CREATE TABLE flow_templates (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        template_key VARCHAR(40) NOT NULL,
        name VARCHAR(100) NOT NULL,
        description VARCHAR(500) NULL,
        department_id INT UNSIGNED NULL,
        source_key VARCHAR(40) NULL,
        created_by INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_flow_tpl_key (company_id, template_key),
        KEY idx_flow_tpl_dept (company_id, department_id),
        CONSTRAINT fk_flow_tpl_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE flow_node_templates (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        node_key VARCHAR(40) NOT NULL,
        name VARCHAR(40) NOT NULL,
        description VARCHAR(500) NULL,
        category VARCHAR(20) NOT NULL,
        step_type VARCHAR(12) NOT NULL,
        due_minutes INT UNSIGNED NULL,
        fields JSON NOT NULL,
        source_key VARCHAR(40) NULL,
        revision INT UNSIGNED NOT NULL DEFAULT 1,
        created_by INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_flow_node_tpl (company_id, node_key),
        CONSTRAINT fk_flow_node_tpl_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
    await q.query('ALTER TABLE flow_definitions ADD COLUMN schema_json JSON NULL AFTER steps');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE flow_definitions DROP COLUMN schema_json');
    await q.query('DROP TABLE IF EXISTS flow_node_templates');
    await q.query('DROP TABLE IF EXISTS flow_templates');
  }
}
