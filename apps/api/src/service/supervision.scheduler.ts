import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SupervisionService } from './supervision.service';

/** 每 5 分钟扫描一次：逾期事项登记成异常、按时长升级、办完自动解除。测试环境或 FLOW_SCHEDULER=off 时不启动。 */
@Injectable()
export class SupervisionScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly log = new Logger('SupervisionScheduler');
  constructor(private readonly supervision: SupervisionService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.FLOW_SCHEDULER === 'off') return;
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.supervision.scanAll();
      if (r.created || r.escalated || r.resolved) this.log.log(`监督扫描：新登记 ${r.created}，升级 ${r.escalated}，自动解除 ${r.resolved}`);
    } catch (e) { this.log.error(`监督扫描失败：${(e as Error).message}`); }
    finally { this.running = false; }
  }
}
