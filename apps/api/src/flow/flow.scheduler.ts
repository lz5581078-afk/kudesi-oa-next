import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FlowService } from './flow.service';
import { TaskService } from './task.service';

/** 每分钟扫描一次逾期待办。测试环境或 FLOW_SCHEDULER=off 时不启动。 */
@Injectable()
export class FlowScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly log = new Logger('FlowScheduler');
  constructor(private readonly flow: FlowService, private readonly tasks: TaskService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.FLOW_SCHEDULER === 'off') return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const g = await this.tasks.generateRoutines(); if (g) this.log.log(`生成周期任务 ${g} 条`);
      const n = await this.flow.scanOverdue(); if (n) this.log.log(`逾期提醒 ${n} 条`);
    }
    catch (e) { this.log.error(`逾期扫描失败：${(e as Error).message}`); }
    finally { this.running = false; }
  }
}
