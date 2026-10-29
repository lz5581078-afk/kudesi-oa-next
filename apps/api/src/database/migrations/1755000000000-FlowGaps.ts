import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 流程配置缺口补齐：发起人范围随版本发布（starter_scope，空 = 不限制，沿用原有行为）；版本记录发布人（published_by）。
 * 只加可空列，老版本两列都为 NULL，行为不变。
 */
export class FlowGaps1755000000000 implements MigrationInterface {
  name = 'FlowGaps1755000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE flow_definitions ADD COLUMN starter_scope JSON NULL AFTER escalate_user_ids, ADD COLUMN published_by INT UNSIGNED NULL AFTER published_at');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE flow_definitions DROP COLUMN starter_scope, DROP COLUMN published_by');
  }
}
