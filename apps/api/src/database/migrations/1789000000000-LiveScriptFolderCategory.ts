import { MigrationInterface, QueryRunner } from 'typeorm';

export class LiveScriptFolderCategory1789000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query("ALTER TABLE live_script_folders ADD COLUMN category VARCHAR(80) NOT NULL DEFAULT ''");
  }
  async down(q: QueryRunner) {
    const [row] = await q.query("SELECT EXISTS(SELECT 1 FROM live_script_folders WHERE category <> '') AS used");
    if (Number(row.used)) throw new Error('已有话术产品分类，不能删除分类字段');
    await q.query('ALTER TABLE live_script_folders DROP COLUMN category');
  }
}
