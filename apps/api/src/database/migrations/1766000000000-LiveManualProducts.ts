import { MigrationInterface, QueryRunner } from 'typeorm';

export class LiveManualProducts1766000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query('ALTER TABLE live_session_products MODIFY base_code_id INT UNSIGNED NULL');
  }
  async down(q: QueryRunner) {
    const [row] = await q.query('SELECT COUNT(*) n FROM live_session_products WHERE base_code_id IS NULL');
    if (Number(row.n)) throw new Error('已保存手填场次产品，不能回退为必须引用基础编码');
    await q.query('ALTER TABLE live_session_products MODIFY base_code_id INT UNSIGNED NOT NULL');
  }
}
