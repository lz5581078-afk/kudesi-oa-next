import { MigrationInterface, QueryRunner } from 'typeorm';

/** 商品基础编码验证事件历史（旧 finance_product_data_verification_events）：每次验证通过追加一行，只增不改，有它的编码不能直接删除。 */
export class ProductVerificationEvents1739000002000 implements MigrationInterface {
  name = 'ProductVerificationEvents1739000002000';
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE finance_product_data_verification_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id INT UNSIGNED NOT NULL,
      base_code_id INT UNSIGNED NOT NULL,
      composition_signature VARCHAR(64) NOT NULL,
      verified_by INT UNSIGNED NULL,
      verified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      snapshot_json JSON NULL,
      PRIMARY KEY (id),
      KEY idx_pv_events_code (company_id, base_code_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner) {
    await q.query('DROP TABLE finance_product_data_verification_events');
  }
}
