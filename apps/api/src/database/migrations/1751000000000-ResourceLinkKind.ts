import { MigrationInterface, QueryRunner } from 'typeorm';

/** 手动关联的“关系类型”（使用/授权/保管/其他）：独立可空列，只加不删，旧数据为空。 */
export class ResourceLinkKind1751000000000 implements MigrationInterface {
  name = 'ResourceLinkKind1751000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE resource_links ADD COLUMN relation_kind VARCHAR(16) NULL AFTER purpose');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE resource_links DROP COLUMN relation_kind');
  }
}
