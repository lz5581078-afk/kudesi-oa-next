import { MigrationInterface, QueryRunner } from 'typeorm';

/** 仅为后续登记留存当时的字段；旧历史不回填。 */
export class CostSnapshotContext1784000000000 implements MigrationInterface {
  name = 'CostSnapshotContext1784000000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_cost_snapshots ADD COLUMN context_json JSON NULL AFTER min_price_cents');
  }
  async down(q: QueryRunner): Promise<void> {
    const [row] = await q.query('SELECT COUNT(*) AS n FROM finance_cost_snapshots WHERE context_json IS NOT NULL');
    if (Number(row.n)) throw new Error('已有成本历史上下文，请保留历史后再回退结构');
    await q.query('ALTER TABLE finance_cost_snapshots DROP COLUMN context_json');
  }
}
