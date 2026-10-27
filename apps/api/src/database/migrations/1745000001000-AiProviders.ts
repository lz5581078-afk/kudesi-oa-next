import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 多 AI 服务商：服务商（密钥加密）、从服务商同步来的模型目录、各识别场景的默认模型。
 * 旧系统是 ai_service_providers / ai_service_models / ai_company_settings 三张表，这里按同样的分工重建。
 */
export class AiProviders1745000001000 implements MigrationInterface {
  name = 'AiProviders1745000001000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE ai_providers (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        provider_key VARCHAR(40) NOT NULL,
        name VARCHAR(80) NOT NULL,
        base_url VARCHAR(200) NOT NULL,
        model_name VARCHAR(100) NULL,
        api_key_enc TEXT NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'active',
        last_synced_at DATETIME NULL,
        last_sync_error VARCHAR(300) NULL,
        created_by INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ai_provider_key (company_id, provider_key),
        CONSTRAINT fk_ai_provider_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query(`
      CREATE TABLE ai_models (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        provider_id INT UNSIGNED NOT NULL,
        model_id VARCHAR(150) NOT NULL,
        owned_by VARCHAR(80) NULL,
        endpoint_type VARCHAR(24) NOT NULL DEFAULT 'chat-completions',
        capabilities JSON NULL,
        synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ai_model (provider_id, model_id),
        KEY idx_ai_model_company (company_id, provider_id),
        CONSTRAINT fk_ai_model_provider FOREIGN KEY (provider_id) REFERENCES ai_providers (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query(`
      CREATE TABLE ai_company_settings (
        company_id INT UNSIGNED NOT NULL,
        setting_key VARCHAR(40) NOT NULL,
        provider_id INT UNSIGNED NOT NULL,
        model_id VARCHAR(150) NOT NULL,
        updated_by INT UNSIGNED NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (company_id, setting_key),
        CONSTRAINT fk_ai_setting_provider FOREIGN KEY (provider_id) REFERENCES ai_providers (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS ai_company_settings');
    await q.query('DROP TABLE IF EXISTS ai_models');
    await q.query('DROP TABLE IF EXISTS ai_providers');
  }
}
