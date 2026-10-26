import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 助手升级包发布：管理员在 OA 上传升级包（版本号 + SHA-256 由服务器从包里和文件本身算出），
 * 助手只能用设备令牌下载自己公司、且正是被安排升级的那个版本。
 * session_devices.update_error：升级失败 / 已回退的原因（update_status 新增 downloading/verifying/staged/applying/restarting/failed/rolled_back）。
 */
export class AgentReleases1730007000000 implements MigrationInterface {
  name = 'AgentReleases1730007000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE agent_releases (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        company_id INT UNSIGNED NOT NULL,
        version VARCHAR(30) NOT NULL,
        sha256 CHAR(64) NOT NULL,
        size INT UNSIGNED NOT NULL,
        package LONGBLOB NOT NULL,
        notes VARCHAR(300) NULL,
        created_by INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        withdrawn_at DATETIME NULL,
        UNIQUE KEY uq_agent_release_version (company_id, version),
        CONSTRAINT fk_agent_release_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query('ALTER TABLE session_devices ADD COLUMN update_error VARCHAR(300) NULL AFTER update_status');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE session_devices DROP COLUMN update_error');
    await q.query('DROP TABLE IF EXISTS agent_releases');
  }
}
