import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0001 底座表：公司、部门、岗位、岗位权限、员工、个人权限覆盖、审计日志。
 * 全部 InnoDB + utf8mb4_unicode_ci。已执行的迁移不要再改，需要变更请新增迁移。
 * 迁移只改结构；种子数据放在 src/scripts/seed.ts，不混进迁移。
 */
export class InitialSchema1730000000000 implements MigrationInterface {
  name = 'InitialSchema1730000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

    await queryRunner.query(`
      CREATE TABLE companies (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        code VARCHAR(32) NOT NULL,
        name VARCHAR(100) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_companies_code (code)
      ) ${tail}`);

    await queryRunner.query(`
      CREATE TABLE departments (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        parent_id INT UNSIGNED NULL,
        name VARCHAR(100) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_departments_company_parent (company_id, parent_id),
        CONSTRAINT fk_departments_company FOREIGN KEY (company_id) REFERENCES companies (id),
        CONSTRAINT fk_departments_parent FOREIGN KEY (parent_id) REFERENCES departments (id)
      ) ${tail}`);

    await queryRunner.query(`
      CREATE TABLE positions (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        department_id INT UNSIGNED NULL,
        name VARCHAR(100) NOT NULL,
        workspace_type VARCHAR(32) NOT NULL DEFAULT 'blank',
        sort_order INT NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        UNIQUE KEY uq_positions_company_name (company_id, name),
        CONSTRAINT fk_positions_company FOREIGN KEY (company_id) REFERENCES companies (id),
        CONSTRAINT fk_positions_department FOREIGN KEY (department_id) REFERENCES departments (id)
      ) ${tail}`);

    await queryRunner.query(`
      CREATE TABLE position_permissions (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        position_id INT UNSIGNED NOT NULL,
        permission VARCHAR(100) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_position_permission (position_id, permission),
        CONSTRAINT fk_position_permissions_position FOREIGN KEY (position_id) REFERENCES positions (id) ON DELETE CASCADE
      ) ${tail}`);

    await queryRunner.query(`
      CREATE TABLE users (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        account VARCHAR(64) NOT NULL,
        password_hash VARCHAR(100) NOT NULL,
        name VARCHAR(50) NOT NULL,
        department_id INT UNSIGNED NULL,
        position_id INT UNSIGNED NULL,
        is_company_admin TINYINT(1) NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        must_change_password TINYINT(1) NOT NULL DEFAULT 1,
        last_login_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_company_account (company_id, account),
        CONSTRAINT fk_users_company FOREIGN KEY (company_id) REFERENCES companies (id),
        CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments (id),
        CONSTRAINT fk_users_position FOREIGN KEY (position_id) REFERENCES positions (id)
      ) ${tail}`);

    await queryRunner.query(`
      CREATE TABLE user_permission_overrides (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id INT UNSIGNED NOT NULL,
        permission VARCHAR(100) NOT NULL,
        effect VARCHAR(8) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_user_permission_override (user_id, permission),
        CONSTRAINT fk_user_overrides_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ${tail}`);

    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        actor_id INT UNSIGNED NULL,
        action VARCHAR(64) NOT NULL,
        resource_type VARCHAR(64) NOT NULL,
        resource_id VARCHAR(64) NULL,
        detail JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_audit_company_time (company_id, created_at),
        CONSTRAINT fk_audit_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'audit_logs',
      'user_permission_overrides',
      'users',
      'position_permissions',
      'positions',
      'departments',
      'companies',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${table}`);
    }
  }
}
