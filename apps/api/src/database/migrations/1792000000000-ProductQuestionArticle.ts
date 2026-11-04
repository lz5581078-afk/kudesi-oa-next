import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductQuestionArticle1792000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query('ALTER TABLE live_script_folders ADD faq_article MEDIUMTEXT NULL');
  }
  async down(q: QueryRunner) {
    const [row] = await q.query(
      'SELECT EXISTS(SELECT 1 FROM live_script_folders WHERE faq_article IS NOT NULL) used',
    );
    if (Number(row.used)) throw new Error('已有独立问题文章，不能删除正文');
    await q.query('ALTER TABLE live_script_folders DROP COLUMN faq_article');
  }
}
