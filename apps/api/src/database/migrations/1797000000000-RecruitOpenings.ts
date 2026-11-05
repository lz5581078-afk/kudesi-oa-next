import { MigrationInterface, QueryRunner } from 'typeorm';

/** 招聘岗位：可从部门岗位导入或手工添加；求职者登记时选择应聘岗位（登记表记下岗位名称快照）。 */
export class RecruitOpenings1797000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE recruit_openings (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, company_id INT UNSIGNED NOT NULL,
      position_id INT UNSIGNED NULL, title VARCHAR(100) NOT NULL, department_name VARCHAR(100) NULL,
      headcount INT UNSIGNED NULL, requirements VARCHAR(1000) NULL, status VARCHAR(10) NOT NULL DEFAULT 'open',
      created_by INT UNSIGNED NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_recruit_opening_position (company_id, position_id), KEY idx_recruit_opening_company (company_id, status, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await q.query('ALTER TABLE recruit_applications ADD opening_id INT UNSIGNED NULL, ADD opening_title VARCHAR(100) NULL');
  }
  async down(q: QueryRunner) {
    const [r] = await q.query('SELECT (SELECT COUNT(*) FROM recruit_openings)+(SELECT COUNT(*) FROM recruit_applications WHERE opening_id IS NOT NULL) n');
    if (Number(r.n)) throw new Error('已有招聘岗位数据，不能回退结构');
    await q.query('ALTER TABLE recruit_applications DROP COLUMN opening_id, DROP COLUMN opening_title');
    await q.query('DROP TABLE recruit_openings');
  }
}
