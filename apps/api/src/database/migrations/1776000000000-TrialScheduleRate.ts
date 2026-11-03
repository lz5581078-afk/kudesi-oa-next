import { MigrationInterface, QueryRunner } from 'typeorm';

export class TrialScheduleRate1776000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query('ALTER TABLE live_schedules ADD trial_hourly_rate_cents INT UNSIGNED NULL');
  }
  async down(q: QueryRunner) {
    const [used] = await q.query('SELECT COUNT(*) n FROM live_schedules WHERE trial_hourly_rate_cents IS NOT NULL');
    if (Number(used.n)) throw new Error('已有排班记录了试播时薪，无法回退结构');
    await q.query('ALTER TABLE live_schedules DROP COLUMN trial_hourly_rate_cents');
  }
}
