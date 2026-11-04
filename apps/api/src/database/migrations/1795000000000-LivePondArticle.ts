import { MigrationInterface, QueryRunner } from 'typeorm';

export class LivePondArticle1795000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE live_pond_articles (
      company_id INT UNSIGNED NOT NULL PRIMARY KEY,
      body MEDIUMTEXT NOT NULL,
      revision INT UNSIGNED NOT NULL,
      CONSTRAINT fk_live_pond_company FOREIGN KEY (company_id) REFERENCES companies(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner) {
    const [row] = await q.query('SELECT EXISTS(SELECT 1 FROM live_pond_articles) used');
    if (Number(row.used)) throw new Error('鱼塘问题库已有内容，不能删除');
    await q.query('DROP TABLE live_pond_articles');
  }
}
