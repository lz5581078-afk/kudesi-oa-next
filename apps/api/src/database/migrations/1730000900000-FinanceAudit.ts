import { MigrationInterface, QueryRunner } from 'typeorm';

/** 财务审核（管家婆经营历程里的“财务审核”）：审核后的单据不能再红冲、不能再改表头。 */
export class FinanceAudit1730000900000 implements MigrationInterface {
  name = 'FinanceAudit1730000900000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_documents ADD COLUMN audited_by INT UNSIGNED NULL AFTER posted_at, ADD COLUMN audited_at DATETIME NULL AFTER audited_by');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_documents DROP COLUMN audited_at, DROP COLUMN audited_by');
  }
}
