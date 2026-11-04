import {MigrationInterface,QueryRunner} from 'typeorm';
/** 仅偏好结构；原费用历史包缺失顺序的保持NULL，不伪造历史。 */
export class UserPreferences1791000000000 implements MigrationInterface{
 name='UserPreferences1791000000000';
 async up(q:QueryRunner):Promise<void>{await q.query(`CREATE TABLE user_preferences(company_id INT UNSIGNED NOT NULL,user_id INT UNSIGNED NOT NULL,preference_key VARCHAR(80) NOT NULL,value JSON NOT NULL,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,PRIMARY KEY(company_id,user_id,preference_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);await q.query('ALTER TABLE finance_fee_snapshots ADD COLUMN sort_preference JSON NULL');}
 async down(q:QueryRunner):Promise<void>{await q.query('ALTER TABLE finance_fee_snapshots DROP COLUMN sort_preference');await q.query('DROP TABLE user_preferences');}
}
