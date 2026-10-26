import { MigrationInterface, QueryRunner } from 'typeorm';

/** 员工兼任岗位：主岗位仍是 position_id（决定默认工作台），其余岗位放这里，权限取并集。 */
export class ExtraPositions1730001700000 implements MigrationInterface {
  name = 'ExtraPositions1730001700000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE users ADD COLUMN extra_position_ids JSON NULL');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE users DROP COLUMN extra_position_ids');
  }
}
