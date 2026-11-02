import { MigrationInterface, QueryRunner } from 'typeorm';

export class LiveScheduleProducts1763000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query('ALTER TABLE live_schedules ADD products_json JSON NULL');
  }
  async down(q: QueryRunner) {
    const [used] = await q.query('SELECT COUNT(*) n FROM live_schedules WHERE JSON_LENGTH(products_json) > 0');
    if (Number(used.n)) throw new Error('排场已保存产品，不能回退结构');
    await q.query('ALTER TABLE live_schedules DROP COLUMN products_json');
  }
}
