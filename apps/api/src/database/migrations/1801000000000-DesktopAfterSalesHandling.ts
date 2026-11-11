import { MigrationInterface, QueryRunner } from 'typeorm';

export class DesktopAfterSalesHandling1801000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE desktop_after_sales
      ADD workspace_state ENUM('open','tear','closed') NULL,
      ADD reminder_at DATETIME NULL,
      ADD reminder_user_id INT UNSIGNED NULL,
      ADD INDEX idx_desktop_workspace_state(company_id,workspace_state,application_at,id),
      ADD INDEX idx_desktop_reminder(reminder_at,id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [existing] = await queryRunner.query(`SELECT id FROM desktop_after_sales
      WHERE workspace_state IN ('tear','closed') OR reminder_at IS NOT NULL LIMIT 1`);
    if (existing) throw new Error('存在售后处理状态或跟进提醒，请保留迁移并核对备份');
    await queryRunner.query(`ALTER TABLE desktop_after_sales
      DROP INDEX idx_desktop_workspace_state,
      DROP INDEX idx_desktop_reminder,
      DROP COLUMN workspace_state,
      DROP COLUMN reminder_at,
      DROP COLUMN reminder_user_id`);
  }
}
