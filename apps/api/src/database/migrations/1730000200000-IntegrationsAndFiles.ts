import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0003 接口设置与文件：
 * - integration_settings：按公司保存第三方接口参数（七牛、识别大模型），内容整体加密
 * - resource_files：资料里的图片/附件，实际文件在七牛，这里只存索引
 */
export class IntegrationsAndFiles1730000200000 implements MigrationInterface {
  name = 'IntegrationsAndFiles1730000200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

    await queryRunner.query(`
      CREATE TABLE integration_settings (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        setting_key VARCHAR(32) NOT NULL,
        config_enc TEXT NOT NULL,
        updated_by INT UNSIGNED NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_integration_setting (company_id, setting_key),
        CONSTRAINT fk_integration_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);

    await queryRunner.query(`
      CREATE TABLE resource_files (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        resource_type VARCHAR(32) NOT NULL,
        resource_id INT UNSIGNED NULL,
        field_key VARCHAR(48) NOT NULL,
        storage_key VARCHAR(300) NOT NULL,
        name VARCHAR(200) NOT NULL,
        mime VARCHAR(64) NOT NULL,
        size INT UNSIGNED NOT NULL,
        uploaded_by INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_resource_files_owner (company_id, resource_type, resource_id),
        KEY idx_resource_files_orphan (resource_id, created_at),
        CONSTRAINT fk_resource_files_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS resource_files');
    await queryRunner.query('DROP TABLE IF EXISTS integration_settings');
  }
}
