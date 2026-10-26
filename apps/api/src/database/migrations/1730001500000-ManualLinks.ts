import { MigrationInterface, QueryRunner } from 'typeorm';

/** 资料之间的手动关联（relation = 'manual'）：同一条记录可以关联多条，所以唯一键要带上对方。 */
export class ManualLinks1730001500000 implements MigrationInterface {
  name = 'ManualLinks1730001500000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE resource_links ADD UNIQUE KEY uq_resource_link_target (company_id, source_id, relation, target_type, target_id)');
    await q.query('ALTER TABLE resource_links DROP INDEX uq_resource_link');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query("DELETE FROM resource_links WHERE relation = 'manual'");
    await q.query('ALTER TABLE resource_links ADD UNIQUE KEY uq_resource_link (company_id, source_id, relation)');
    await q.query('ALTER TABLE resource_links DROP INDEX uq_resource_link_target');
  }
}
