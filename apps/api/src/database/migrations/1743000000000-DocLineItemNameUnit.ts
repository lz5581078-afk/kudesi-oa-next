import { MigrationInterface, QueryRunner } from 'typeorm';

/** 单据明细行：金额类单据（收款/付款/预收/预付/转款）的多行金额明细要有“项目名称”；商品行记录单位文字。只加列，老单据不受影响。 */
export class DocLineItemNameUnit1743000000000 implements MigrationInterface {
  name = 'DocLineItemNameUnit1743000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_document_lines ADD COLUMN item_name VARCHAR(100) NULL AFTER related_name, ADD COLUMN unit VARCHAR(20) NULL AFTER item_name');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_document_lines DROP COLUMN unit, DROP COLUMN item_name');
  }
}
