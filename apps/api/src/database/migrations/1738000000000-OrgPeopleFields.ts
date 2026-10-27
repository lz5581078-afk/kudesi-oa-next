import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 人事补齐（旧系统员工/岗位/部门档案里有、重写时丢掉的字段）：
 * 员工的计薪方式、时薪、用工类型；部门主管（显式字段，不再按名称猜）；系统归档部门（离职员工）；岗位编码；员工薪酬记录。
 * 只改结构；时薪和金额一样用整数分。
 */
export class OrgPeopleFields1738000000000 implements MigrationInterface {
  name = 'OrgPeopleFields1738000000000';

  async up(q: QueryRunner) {
    await q.query("ALTER TABLE users ADD COLUMN pay_type varchar(12) NOT NULL DEFAULT 'monthly', ADD COLUMN hourly_rate bigint NULL, ADD COLUMN employment_type varchar(16) NOT NULL DEFAULT 'regular'");
    await q.query('ALTER TABLE departments ADD COLUMN manager_id int unsigned NULL, ADD COLUMN is_system tinyint(1) NOT NULL DEFAULT 0');
    await q.query('ALTER TABLE positions ADD COLUMN position_key varchar(64) NULL');
    await q.query('CREATE UNIQUE INDEX uq_positions_dept_key ON positions (company_id, department_id, position_key)');
    await q.query(`CREATE TABLE employee_compensation_records (
      id bigint unsigned NOT NULL AUTO_INCREMENT,
      company_id int unsigned NOT NULL,
      user_id int unsigned NOT NULL,
      record_type varchar(40) NOT NULL,
      title varchar(160) NOT NULL,
      amount bigint NOT NULL DEFAULT 0,
      effective_date date NULL,
      pay_period varchar(40) NULL,
      reason varchar(500) NULL,
      source_type varchar(80) NULL,
      source_id bigint unsigned NULL,
      actor_id int unsigned NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_comp_user_type (company_id, user_id, record_type, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  async down(q: QueryRunner) {
    await q.query('DROP TABLE employee_compensation_records');
    await q.query('DROP INDEX uq_positions_dept_key ON positions');
    await q.query('ALTER TABLE positions DROP COLUMN position_key');
    await q.query('ALTER TABLE departments DROP COLUMN manager_id, DROP COLUMN is_system');
    await q.query('ALTER TABLE users DROP COLUMN pay_type, DROP COLUMN hourly_rate, DROP COLUMN employment_type');
  }
}
