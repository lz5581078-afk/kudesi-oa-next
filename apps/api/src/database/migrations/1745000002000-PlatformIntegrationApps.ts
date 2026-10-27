import { MigrationInterface, QueryRunner } from 'typeorm';

/** 平台级接口应用配置：聚水潭/飞书/海康的应用密钥由平台管理员统一配置，密钥类全部加密保存。 */
export class PlatformIntegrationApps1745000002000 implements MigrationInterface {
  name = 'PlatformIntegrationApps1745000002000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE platform_integration_apps (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        integration_key VARCHAR(30) NOT NULL,
        environment VARCHAR(16) NOT NULL DEFAULT 'production',
        app_key_enc TEXT NOT NULL,
        app_secret_enc TEXT NOT NULL,
        base_url VARCHAR(200) NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'active',
        remark VARCHAR(200) NULL,
        updated_by INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_platform_app (integration_key, environment)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS platform_integration_apps');
  }
}
