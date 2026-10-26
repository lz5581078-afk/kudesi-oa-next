import { MigrationInterface, QueryRunner } from 'typeorm';
/** 只改单位报价/成本精度；单据金额、分录、收付款列仍是整数分。 */
export class UnitPricePrecision1734000000000 implements MigrationInterface {
  name = 'UnitPricePrecision1734000000000';
  async up(q: QueryRunner) {
    await q.query('ALTER TABLE finance_document_lines MODIFY unit_price_cents decimal(24,4) NOT NULL, MODIFY unit_cost_cents decimal(24,4) NULL');
    await q.query('ALTER TABLE finance_cost_snapshots MODIFY pre_ship_cost_cents decimal(24,4) NULL');
  }
  async down(q: QueryRunner) {
    const [a] = await q.query('SELECT COUNT(*) n FROM finance_document_lines WHERE unit_price_cents<>ROUND(unit_price_cents) OR unit_cost_cents<>ROUND(unit_cost_cents)');
    const [b] = await q.query('SELECT COUNT(*) n FROM finance_cost_snapshots WHERE pre_ship_cost_cents<>ROUND(pre_ship_cost_cents)');
    if (Number(a.n) || Number(b.n)) throw new Error('已有精细单价/成本，不允许截断精度；请先恢复迁前备份');
    await q.query('ALTER TABLE finance_document_lines MODIFY unit_price_cents bigint NOT NULL, MODIFY unit_cost_cents bigint NULL');
    await q.query('ALTER TABLE finance_cost_snapshots MODIFY pre_ship_cost_cents bigint NULL');
  }
}
