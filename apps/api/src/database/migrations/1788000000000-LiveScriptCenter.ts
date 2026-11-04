import { MigrationInterface, QueryRunner } from 'typeorm';

export class LiveScriptCenter1788000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE live_script_folders (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, company_id INT UNSIGNED NOT NULL, name VARCHAR(100) NOT NULL,
      UNIQUE KEY uq_live_script_folder_name(company_id,name), UNIQUE KEY uq_live_script_folder(company_id,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await q.query(`CREATE TABLE live_script_versions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, company_id INT UNSIGNED NOT NULL, folder_id INT UNSIGNED NOT NULL,
      name VARCHAR(100) NOT NULL, notes TEXT NOT NULL, body MEDIUMTEXT NOT NULL, cues JSON NOT NULL, revision INT UNSIGNED NOT NULL DEFAULT 1,
      CONSTRAINT fk_live_script_folder FOREIGN KEY(company_id,folder_id) REFERENCES live_script_folders(company_id,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(q: QueryRunner) {
    const [used] = await q.query('SELECT EXISTS(SELECT 1 FROM live_script_folders) AS used');
    if (Number(used.used)) throw new Error('话术中心已有资料，不能删除数据表');
    await q.query('DROP TABLE live_script_versions');
    await q.query('DROP TABLE live_script_folders');
  }
}
