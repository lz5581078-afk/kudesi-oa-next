import { MigrationInterface, QueryRunner } from 'typeorm';
/** 手动关联的属性（旧系统同款）：用途、有效期起止（如商标授权给某店铺的起止日期） */
export class ResourceLinkProps1735000000001 implements MigrationInterface {
  name = 'ResourceLinkProps1735000000001';
  async up(q: QueryRunner) {
    await q.query('ALTER TABLE resource_links ADD valid_from date NULL, ADD valid_to date NULL, ADD purpose varchar(200) NULL');
  }
  async down(q: QueryRunner) {
    const [r] = await q.query('SELECT COUNT(*) n FROM resource_links WHERE valid_from IS NOT NULL OR valid_to IS NOT NULL OR purpose IS NOT NULL');
    if (Number(r.n)) throw new Error('已有关联属性数据，不允许移除；请先恢复迁前备份');
    await q.query('ALTER TABLE resource_links DROP valid_from, DROP valid_to, DROP purpose');
  }
}
