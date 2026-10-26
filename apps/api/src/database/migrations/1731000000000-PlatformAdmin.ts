import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 平台后台：平台管理员、企业开通申请；登录不再填公司代码，所以员工账号要全系统唯一。
 * 唯一性由所有开账号的入口（新建员工、通过申请、种子脚本、建平台管理员）在事务内检查；
 * 数据库只建普通索引（不建唯一索引），因为已有数据和测试夹具里可能存在不同公司同名账号，
 * 万一出现同名，登录会直接拒绝（见 AuthService.login），不会串到别家公司。
 */
export class PlatformAdmin1731000000000 implements MigrationInterface {
  name = 'PlatformAdmin1731000000000';

  public async up(q: QueryRunner): Promise<void> {
    const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await q.query(`CREATE TABLE platform_admins (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        account VARCHAR(64) NOT NULL,
        password_hash VARCHAR(100) NOT NULL,
        name VARCHAR(50) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        last_login_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_platform_admin_account (account)
      ) ${tail}`);
    await q.query(`CREATE TABLE company_applications (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        company_name VARCHAR(100) NOT NULL,
        contact_name VARCHAR(50) NOT NULL,
        contact_phone VARCHAR(20) NOT NULL,
        admin_account VARCHAR(64) NOT NULL,
        admin_password_hash VARCHAR(100) NOT NULL,
        contact_title VARCHAR(50) NULL,
        remark VARCHAR(500) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        reject_reason VARCHAR(300) NULL,
        reviewed_by INT UNSIGNED NULL,
        reviewed_at DATETIME NULL,
        approved_company_id INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_company_applications_status (status, created_at),
        KEY idx_company_applications_account (admin_account),
        CONSTRAINT fk_company_app_reviewer FOREIGN KEY (reviewed_by) REFERENCES platform_admins (id),
        CONSTRAINT fk_company_app_company FOREIGN KEY (approved_company_id) REFERENCES companies (id)
      ) ${tail}`);
    await q.query('ALTER TABLE users ADD KEY idx_users_account (account)');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE users DROP INDEX idx_users_account');
    await q.query('DROP TABLE IF EXISTS company_applications');
    await q.query('DROP TABLE IF EXISTS platform_admins');
  }
}
