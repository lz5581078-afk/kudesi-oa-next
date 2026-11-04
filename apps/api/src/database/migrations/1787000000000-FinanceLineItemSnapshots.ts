import {MigrationInterface,QueryRunner} from 'typeorm';

/** 名称与编码是开单时事实；旧行保持NULL，只在读取时注明当前档案回退。 */
export class FinanceLineItemSnapshots1787000000000 implements MigrationInterface{
  name='FinanceLineItemSnapshots1787000000000';
  async up(q:QueryRunner):Promise<void>{
    await q.query('ALTER TABLE finance_document_lines MODIFY COLUMN item_name VARCHAR(512) NULL, ADD COLUMN product_name VARCHAR(200) NULL, ADD COLUMN fee_item_name VARCHAR(200) NULL, ADD COLUMN item_code VARCHAR(160) NULL');
  }
  async down(q:QueryRunner):Promise<void>{
    await q.query('ALTER TABLE finance_document_lines DROP COLUMN item_code, DROP COLUMN fee_item_name, DROP COLUMN product_name');
    // 保留文字扩容，不能截断已保存的项目名称。
  }
}
