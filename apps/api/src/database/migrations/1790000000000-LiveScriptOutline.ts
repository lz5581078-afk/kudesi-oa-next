import { MigrationInterface, QueryRunner } from 'typeorm';

export class LiveScriptOutline1790000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    if (!(await q.hasColumn('live_script_versions', 'outline')))
      await q.query('ALTER TABLE live_script_versions ADD outline JSON NULL');
    if (!(await q.hasColumn('live_script_folders', 'faq')))
      await q.query(
        'ALTER TABLE live_script_folders ADD faq JSON NULL, ADD faq_revision INT UNSIGNED NOT NULL DEFAULT 1',
      );
    await q.query(
      'CREATE TABLE IF NOT EXISTS live_script_templates (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, company_id INT UNSIGNED NOT NULL, name VARCHAR(100) NOT NULL, stages JSON NOT NULL, UNIQUE KEY uq_company_template(company_id,name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
  }
  async down(q: QueryRunner) {
    const [r] = await q.query(
      'SELECT EXISTS(SELECT 1 FROM live_script_templates) OR EXISTS(SELECT 1 FROM live_script_versions WHERE outline IS NOT NULL) OR EXISTS(SELECT 1 FROM live_script_folders WHERE faq IS NOT NULL) used',
    );
    if (Number(r.used)) throw new Error('已有目录或问答，不能删除');
    await q.query('DROP TABLE live_script_templates');
    await q.query('ALTER TABLE live_script_folders DROP COLUMN faq, DROP COLUMN faq_revision');
    await q.query('ALTER TABLE live_script_versions DROP COLUMN outline');
  }
}
