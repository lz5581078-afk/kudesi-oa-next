import { MigrationInterface, QueryRunner } from 'typeorm';

/** 转款单多账户分配；费用/收入行的“挂账节点 + 挂账对象”。 */
export class TransferAccountsAndLineObjects1730001000000 implements MigrationInterface {
  name = 'TransferAccountsAndLineObjects1730001000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE finance_document_accounts (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        document_id INT UNSIGNED NOT NULL,
        role VARCHAR(4) NOT NULL,
        bank_account_id INT UNSIGNED NOT NULL,
        amount_cents BIGINT NOT NULL,
        PRIMARY KEY (id),
        KEY idx_fin_acc_doc (document_id),
        CONSTRAINT fk_fin_acc_doc FOREIGN KEY (document_id) REFERENCES finance_documents (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query(`ALTER TABLE finance_document_lines
      ADD COLUMN related_node VARCHAR(20) NULL AFTER memo,
      ADD COLUMN related_id INT UNSIGNED NULL AFTER related_node,
      ADD COLUMN related_name VARCHAR(100) NULL AFTER related_id`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_document_lines DROP COLUMN related_name, DROP COLUMN related_id, DROP COLUMN related_node');
    await q.query('DROP TABLE IF EXISTS finance_document_accounts');
  }
}
