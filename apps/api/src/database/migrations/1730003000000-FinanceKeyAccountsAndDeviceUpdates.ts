import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 现金银行查询的“重点账户”（每个人自己标记）；授权电脑的升级安排（目标版本、状态）。
 * 授权电脑“删除记录”用 status = 'deleted'（软删除），不需要改结构。
 */
export class FinanceKeyAccountsAndDeviceUpdates1730003000000 implements MigrationInterface {
  name = 'FinanceKeyAccountsAndDeviceUpdates1730003000000';

  public async up(q: QueryRunner): Promise<void> {
    const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await q.query(`CREATE TABLE finance_key_accounts (
        company_id INT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NOT NULL,
        bank_account_id INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (company_id, user_id, bank_account_id),
        CONSTRAINT fk_key_account_company FOREIGN KEY (company_id) REFERENCES companies (id)
      ) ${tail}`);
    await q.query(`ALTER TABLE session_devices
      ADD COLUMN update_target VARCHAR(30) NULL AFTER agent_version,
      ADD COLUMN update_status VARCHAR(12) NULL AFTER update_target,
      ADD COLUMN update_requested_at DATETIME NULL AFTER update_status`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE session_devices DROP COLUMN update_requested_at, DROP COLUMN update_status, DROP COLUMN update_target');
    await q.query('DROP TABLE IF EXISTS finance_key_accounts');
  }
}
