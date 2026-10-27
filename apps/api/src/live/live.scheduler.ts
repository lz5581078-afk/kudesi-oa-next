import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LiveScheduleService } from './live-schedule.service';

/** 每分钟扫描一次：开播前 30 分钟提醒本场主播、中控、运营。测试环境或 LIVE_SCHEDULER=off 时不启动。 */
@Injectable()
export class LiveScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly log = new Logger('LiveScheduler');
  constructor(private readonly schedules: LiveScheduleService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.LIVE_SCHEDULER === 'off') return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try { const n = await this.schedules.scanReminders(); if (n) this.log.log(`开播提醒 ${n} 条`); }
    catch (e) { this.log.error(`开播提醒扫描失败：${(e as Error).message}`); }
    finally { this.running = false; }
  }
}
