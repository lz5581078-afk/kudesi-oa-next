import { MigrationInterface, QueryRunner } from 'typeorm';

/** 开单结算（管家婆式）：当场实收/实付金额、往来对象来源、经办人、归属部门。 */
export class FinanceSettlement1730000800000 implements MigrationInterface {
  name = 'FinanceSettlement1730000800000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE finance_documents
      ADD COLUMN paid_cents BIGINT NOT NULL DEFAULT 0 AFTER offset_cents,
      ADD COLUMN party_kind VARCHAR(12) NULL AFTER party_id,
      ADD COLUMN handler VARCHAR(60) NULL AFTER memo,
      ADD COLUMN department VARCHAR(60) NULL AFTER handler`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_documents DROP COLUMN department, DROP COLUMN handler, DROP COLUMN party_kind, DROP COLUMN paid_cents');
  }
}
