import { MigrationInterface, QueryRunner } from 'typeorm';

/** 个人任务四分类：新任务/进行中/待复核/已完成。给待办表加“开始处理、提交复核、复核意见”三列（可空，向后兼容）。 */
export class TaskReviewStages1747000000000 implements MigrationInterface {
  name = 'TaskReviewStages1747000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE work_items ADD COLUMN started_at DATETIME NULL, ADD COLUMN submitted_at DATETIME NULL, ADD COLUMN review_note VARCHAR(500) NULL');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE work_items DROP COLUMN review_note, DROP COLUMN submitted_at, DROP COLUMN started_at');
  }
}
