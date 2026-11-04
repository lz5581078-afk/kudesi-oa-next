import { MigrationInterface, QueryRunner } from 'typeorm';

/** 保留自由填写的相关单位和单独摘要；不把文字单位自动建成往来档案。 */
export class DocCounterpartySummary1783000000000 implements MigrationInterface {
  name = 'DocCounterpartySummary1783000000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_documents ADD COLUMN counterparty_name VARCHAR(160) NULL AFTER party_kind, ADD COLUMN summary VARCHAR(255) NULL AFTER memo');
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_documents DROP COLUMN summary, DROP COLUMN counterparty_name');
  }
}
