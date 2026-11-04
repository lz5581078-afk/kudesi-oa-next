import {MigrationInterface,QueryRunner} from 'typeorm';

/** 只扩容名称快照，不用当前资料名称伪造旧单据的历史事实。 */
export class FinanceRelatedNameSnapshot1786000000000 implements MigrationInterface{
  name='FinanceRelatedNameSnapshot1786000000000';
  async up(q:QueryRunner):Promise<void>{await q.query('ALTER TABLE finance_document_lines MODIFY COLUMN related_name VARCHAR(512) NULL');}
  // 已写入的完整名称不能在回退时被截断，扩容保持向后兼容。
  async down():Promise<void>{}
}
