import { MigrationInterface, QueryRunner } from 'typeorm';

/** 成本历史里的利润率要保留百分数 6 位小数（旧的 4 位会让 12.345678% 存成 12.3457%，每次对比都像“变了”）。 */
export class CostSnapshotMargin61730004000000 implements MigrationInterface {
  name = 'CostSnapshotMargin61730004000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_cost_snapshots MODIFY COLUMN margin_percent DECIMAL(10,6) NULL');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_cost_snapshots MODIFY COLUMN margin_percent DECIMAL(9,4) NULL');
  }
}
