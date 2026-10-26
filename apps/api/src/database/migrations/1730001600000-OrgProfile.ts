import { MigrationInterface, QueryRunner } from 'typeorm';

/** 组织模块补全：部门状态、岗位档案（层级/上级岗位/说明/状态 + 职责条目）、员工上级/职称/底薪。 */
export class OrgProfile1730001600000 implements MigrationInterface {
  name = 'OrgProfile1730001600000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query("ALTER TABLE departments ADD COLUMN status VARCHAR(12) NOT NULL DEFAULT 'active' AFTER sort_order");
    await q.query("ALTER TABLE positions ADD COLUMN level VARCHAR(12) NOT NULL DEFAULT 'staff', ADD COLUMN supervisor_position_id INT UNSIGNED NULL, ADD COLUMN description VARCHAR(1000) NULL, ADD COLUMN status VARCHAR(12) NOT NULL DEFAULT 'active'");
    await q.query(`
      CREATE TABLE position_duties (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        position_id INT UNSIGNED NOT NULL,
        category VARCHAR(20) NOT NULL,
        title VARCHAR(150) NOT NULL,
        description VARCHAR(1000) NULL,
        frequency VARCHAR(60) NULL,
        related_module VARCHAR(60) NULL,
        completion_standard VARCHAR(1000) NULL,
        is_key TINYINT(1) NOT NULL DEFAULT 0,
        status VARCHAR(12) NOT NULL DEFAULT 'active',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_position_duties (company_id, position_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query('ALTER TABLE users ADD COLUMN manager_id INT UNSIGNED NULL, ADD COLUMN title VARCHAR(60) NULL, ADD COLUMN base_salary BIGINT NULL');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE users DROP COLUMN manager_id, DROP COLUMN title, DROP COLUMN base_salary');
    await q.query('DROP TABLE IF EXISTS position_duties');
    await q.query('ALTER TABLE positions DROP COLUMN level, DROP COLUMN supervisor_position_id, DROP COLUMN description, DROP COLUMN status');
    await q.query('ALTER TABLE departments DROP COLUMN status');
  }
}
