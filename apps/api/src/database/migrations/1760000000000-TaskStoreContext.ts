import { MigrationInterface, QueryRunner } from 'typeorm';
export class TaskStoreContext1760000000000 implements MigrationInterface {
  name = 'TaskStoreContext1760000000000';
  async up(q: QueryRunner) {
    await q.query('ALTER TABLE work_items ADD COLUMN store_id int unsigned NULL, ADD CONSTRAINT fk_work_item_store FOREIGN KEY (store_id) REFERENCES resource_records(id)');
  }
  async down(q: QueryRunner) {
    const [r] = await q.query('SELECT COUNT(*) n FROM work_items WHERE store_id IS NOT NULL');
    if (Number(r.n)) throw new Error('待办已有关联店铺，禁止通过回退结构丢失关联');
    await q.query('ALTER TABLE work_items DROP FOREIGN KEY fk_work_item_store, DROP COLUMN store_id');
  }
}
