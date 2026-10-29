import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 制单中心第二批（只加列，老单据不变）：
 * - handler_id：经手人改为员工选择器后的员工 id（handler 文字仍保留，老数据继续显示）；
 * - fee_cents / fee_bearer：转款单手续费及承担方（out 转出方 / in 转入方），默认 0；
 * - transit_status / confirmed_by / confirmed_at：转款单“在途待确认”与“确认入账”（NULL=普通转款，pending=在途，confirmed=已确认）。
 * 收付款优惠复用 discount_cents，多账户收付款复用 finance_document_accounts，所以这两项不需要改表。
 */
export class DocPayAccountsTransferFee1754000000000 implements MigrationInterface {
  name = 'DocPayAccountsTransferFee1754000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE finance_documents
      ADD COLUMN handler_id INT UNSIGNED NULL AFTER handler,
      ADD COLUMN fee_cents BIGINT NOT NULL DEFAULT 0 AFTER discount_cents,
      ADD COLUMN fee_bearer VARCHAR(4) NULL AFTER fee_cents,
      ADD COLUMN transit_status VARCHAR(10) NULL AFTER fee_bearer,
      ADD COLUMN confirmed_by INT UNSIGNED NULL AFTER transit_status,
      ADD COLUMN confirmed_at DATETIME NULL AFTER confirmed_by`);
    await q.query('CREATE INDEX idx_fin_doc_transit ON finance_documents (company_id, transit_status)');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX idx_fin_doc_transit ON finance_documents');
    await q.query('ALTER TABLE finance_documents DROP COLUMN confirmed_at, DROP COLUMN confirmed_by, DROP COLUMN transit_status, DROP COLUMN fee_bearer, DROP COLUMN fee_cents, DROP COLUMN handler_id');
  }
}
