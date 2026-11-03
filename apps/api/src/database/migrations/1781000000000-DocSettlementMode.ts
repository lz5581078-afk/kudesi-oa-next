import { MigrationInterface, QueryRunner } from 'typeorm';

/** 仅记录原有收付方式；历史空值继续按旧金额单全额收付处理，不更改旧分录或余额。 */
export class DocSettlementMode1781000000000 implements MigrationInterface {
  name = 'DocSettlementMode1781000000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_documents ADD COLUMN settlement_mode VARCHAR(12) NULL AFTER paid_cents');
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_documents DROP COLUMN settlement_mode');
  }
}
