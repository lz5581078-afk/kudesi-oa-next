import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0004 财务单据：单据头、明细、分录、事件、单号计数器。
 * 分录是账的唯一来源：借方为正、贷方为负，一张单据合计为 0。红冲 = 一张金额取反的新单据。
 */
export class FinanceDocuments1730000300000 implements MigrationInterface {
  name = 'FinanceDocuments1730000300000';

  public async up(q: QueryRunner): Promise<void> {
    const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await q.query(`
      CREATE TABLE finance_documents (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        doc_no VARCHAR(32) NOT NULL,
        doc_type VARCHAR(24) NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'draft',
        doc_date DATE NOT NULL,
        party_id INT UNSIGNED NULL,
        bank_account_id INT UNSIGNED NULL,
        to_bank_account_id INT UNSIGNED NULL,
        warehouse_id INT UNSIGNED NULL,
        amount_cents BIGINT NOT NULL DEFAULT 0,
        offset_cents BIGINT NOT NULL DEFAULT 0,
        memo VARCHAR(500) NULL,
        source_key VARCHAR(120) NULL,
        reverses_id INT UNSIGNED NULL,
        reversed_by_id INT UNSIGNED NULL,
        created_by INT UNSIGNED NOT NULL,
        issued_at DATETIME NULL,
        posted_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_fin_doc_no (company_id, doc_no),
        UNIQUE KEY uq_fin_doc_source (company_id, source_key),
        KEY idx_fin_doc_list (company_id, status, doc_date),
        KEY idx_fin_doc_type (company_id, doc_type, doc_date),
        CONSTRAINT fk_fin_doc_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE finance_document_lines (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        document_id INT UNSIGNED NOT NULL,
        line_no INT NOT NULL,
        product_id INT UNSIGNED NULL,
        fee_item_id INT UNSIGNED NULL,
        qty DECIMAL(18,4) NOT NULL,
        unit_price_cents BIGINT NOT NULL,
        unit_cost_cents BIGINT NULL,
        memo VARCHAR(200) NULL,
        PRIMARY KEY (id),
        KEY idx_fin_line_doc (document_id),
        CONSTRAINT fk_fin_line_doc FOREIGN KEY (document_id) REFERENCES finance_documents (id) ON DELETE CASCADE
      ) ${tail}`);
    await q.query(`
      CREATE TABLE finance_entries (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        document_id INT UNSIGNED NOT NULL,
        entry_date DATE NOT NULL,
        kind VARCHAR(20) NOT NULL,
        account_id INT UNSIGNED NOT NULL DEFAULT 0,
        sub_id INT UNSIGNED NOT NULL DEFAULT 0,
        amount_cents BIGINT NOT NULL,
        qty DECIMAL(18,4) NULL,
        PRIMARY KEY (id),
        KEY idx_fin_entry_account (company_id, kind, account_id, sub_id),
        KEY idx_fin_entry_doc (document_id),
        CONSTRAINT fk_fin_entry_doc FOREIGN KEY (document_id) REFERENCES finance_documents (id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE finance_document_events (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        document_id INT UNSIGNED NOT NULL,
        action VARCHAR(16) NOT NULL,
        actor_id INT UNSIGNED NOT NULL,
        note VARCHAR(500) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_fin_event_doc (document_id),
        CONSTRAINT fk_fin_event_doc FOREIGN KEY (document_id) REFERENCES finance_documents (id)
      ) ${tail}`);
    await q.query(`
      CREATE TABLE finance_doc_counters (
        company_id INT UNSIGNED NOT NULL,
        counter_key VARCHAR(40) NOT NULL,
        value INT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (company_id, counter_key)
      ) ${tail}`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ['finance_doc_counters', 'finance_document_events', 'finance_entries', 'finance_document_lines', 'finance_documents']) await q.query(`DROP TABLE IF EXISTS ${t}`);
  }
}
