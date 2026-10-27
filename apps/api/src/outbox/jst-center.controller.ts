import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { OutboxService, PRICE_CHANNEL } from './outbox.service';

/**
 * 聚水潭同步能力中心的实时部分（只读）：总开关、发送器是否接入、队列积压和最近失败。
 * 这里不做任何外部调用，也不改任何东西。
 */
@Controller('system/jst-center')
export class JstCenterController {
  constructor(private readonly outbox: OutboxService, @InjectDataSource() private readonly ds: DataSource) {}

  @RequirePermission('system.jst-sync-center.view')
  @Get()
  async overview(@CurrentUser() u: AuthUser) {
    const sw = await this.outbox.getSwitch(u.companyId);
    const price = await this.outbox.getSwitch(u.companyId, PRICE_CHANNEL);
    const rows: Array<{ kind: string; status: string; n: string }> = await this.ds.query(
      'SELECT kind, status, COUNT(*) AS n FROM outbox_jobs WHERE company_id = ? GROUP BY kind, status', [u.companyId]);
    const counts: Record<string, number> = {};
    const byKind: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      counts[r.status] = (counts[r.status] ?? 0) + Number(r.n);
      (byKind[r.kind] ??= {})[r.status] = Number(r.n);
    }
    const [oldest] = await this.ds.query("SELECT MIN(created_at) AS at FROM outbox_jobs WHERE company_id = ? AND status = 'pending'", [u.companyId]);
    const failures = await this.ds.query(
      "SELECT id, kind, resource_type AS resourceType, resource_id AS resourceId, attempts, last_error AS lastError, created_at AS createdAt FROM outbox_jobs WHERE company_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 5", [u.companyId]);
    return {
      switch: { enabled: sw.enabled, note: sw.note, updatedAt: sw.updatedAt },
      priceSwitch: { enabled: price.enabled, note: price.note, updatedAt: price.updatedAt },
      senderConfigured: sw.senderConfigured,
      counts, byKind, oldestPendingAt: oldest?.at ?? null, failures,
    };
  }
}
