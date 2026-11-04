import { MigrationInterface, QueryRunner } from 'typeorm';

/** 只增加单位快照；旧分录的历史单位由原单据明细读取，不在迁移中推测回填。 */
export class FinanceEntryUnit1785000000000 implements MigrationInterface {
  name='FinanceEntryUnit1785000000000';
  async up(q:QueryRunner):Promise<void>{await q.query('ALTER TABLE finance_entries ADD COLUMN unit VARCHAR(40) NULL AFTER qty');await q.query('ALTER TABLE finance_document_lines MODIFY COLUMN unit VARCHAR(40) NULL');}
  // 明细的兼容扩宽保留，回退时不截断已保存的原40字单位。
  async down(q:QueryRunner):Promise<void>{await q.query('ALTER TABLE finance_entries DROP COLUMN unit');}
}
