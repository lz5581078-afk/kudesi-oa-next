import { MigrationInterface, QueryRunner } from 'typeorm';

/** 收款单/付款单按单据、按商品结算：这次的钱分给了哪几张单据（哪个商品）。 */
export class DocumentSettlements1730001100000 implements MigrationInterface {
  name = 'DocumentSettlements1730001100000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE finance_document_settlements (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        document_id INT UNSIGNED NOT NULL,
        source_document_id INT UNSIGNED NOT NULL,
        product_id INT UNSIGNED NULL,
        amount_cents BIGINT NOT NULL,
        PRIMARY KEY (id),
        KEY idx_fin_set_doc (document_id),
        KEY idx_fin_set_src (company_id, source_document_id),
        CONSTRAINT fk_fin_set_doc FOREIGN KEY (document_id) REFERENCES finance_documents (id) ON DELETE CASCADE,
        CONSTRAINT fk_fin_set_src FOREIGN KEY (source_document_id) REFERENCES finance_documents (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await q.query("ALTER TABLE finance_documents ADD COLUMN settle_by VARCHAR(8) NULL AFTER paid_cents");
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE finance_documents DROP COLUMN settle_by');
    await q.query('DROP TABLE IF EXISTS finance_document_settlements');
  }
}
