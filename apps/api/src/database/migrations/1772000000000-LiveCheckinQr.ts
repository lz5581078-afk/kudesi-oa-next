import { MigrationInterface, QueryRunner } from 'typeorm';
export class LiveCheckinQr1772000000000 implements MigrationInterface {
  async up(q:QueryRunner) {
    await q.query(`CREATE TABLE live_checkin_qr_codes (
      company_id INT UNSIGNED NOT NULL PRIMARY KEY,
      qr_token_cipher TEXT NOT NULL, qr_token_hash CHAR(64) NOT NULL,
      qr_version INT UNSIGNED NOT NULL, updated_by INT UNSIGNED NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q:QueryRunner) {
    const [row]=await q.query('SELECT COUNT(*) n FROM live_checkin_qr_codes');
    if(Number(row.n))throw new Error('已有通用上下播二维码，不能回退结构');
    await q.query('DROP TABLE live_checkin_qr_codes');
  }
}
