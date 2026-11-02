import { MigrationInterface, QueryRunner } from 'typeorm';
export class LiveRoomQr1771000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE live_room_settings ADD qr_token_cipher TEXT NULL,
      ADD qr_token_hash CHAR(64) NULL, ADD qr_version INT UNSIGNED NOT NULL DEFAULT 0`);
  }
  async down(q: QueryRunner) {
    const [row] = await q.query('SELECT COUNT(*) n FROM live_room_settings WHERE qr_version>0');
    if (Number(row.n)) throw new Error('已有直播间二维码，不能回退结构');
    await q.query('ALTER TABLE live_room_settings DROP COLUMN qr_token_cipher,DROP COLUMN qr_token_hash,DROP COLUMN qr_version');
  }
}
