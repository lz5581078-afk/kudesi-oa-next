import { MigrationInterface, QueryRunner } from 'typeorm';

/** 单据整单优惠/抹零（管家婆“优惠金额”）：商品类单据的 amount_cents 已是扣优惠后的金额，这里只记优惠额本身。只加列，老单据为 0。 */
export class DocDiscount1753000000000 implements MigrationInterface {
  name = 'DocDiscount1753000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_documents ADD COLUMN discount_cents BIGINT NOT NULL DEFAULT 0 AFTER paid_cents');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_documents DROP COLUMN discount_cents');
  }
}
