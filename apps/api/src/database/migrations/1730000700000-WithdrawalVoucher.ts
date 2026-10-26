import { MigrationInterface, QueryRunner } from 'typeorm';

/** 提现凭证：登录请求增加“截取店铺页面”类型和结果文件。凭证文件本身放在 resource_files（resource_type = withdrawal-voucher）。 */
export class WithdrawalVoucher1730000700000 implements MigrationInterface {
  name = 'WithdrawalVoucher1730000700000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE session_open_requests ADD COLUMN file_id INT UNSIGNED NULL AFTER error_text');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE session_open_requests DROP COLUMN file_id');
  }
}
