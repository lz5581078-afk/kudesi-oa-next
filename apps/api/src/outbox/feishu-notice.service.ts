import { ForbiddenException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { OutboxJob, OutboxSwitch } from '../entities';

/** 飞书通知走出站队列：独立开关（channel=feishu），默认关；没有接入发送器时只积压，不发送。 */
export const FEISHU_CHANNEL = 'feishu';
export const FEISHU_SENDER = 'FEISHU_SENDER';
/** 旧系统只有 SKU 批量申请的节点会发飞书通知；别的流程不发 */
export const FEISHU_TEMPLATES = ['sku-batch-apply'];
const MAX_ATTEMPTS = 5;

export interface FeishuNotice { userId: number; title: string; body?: string; link?: string; runId?: number }
export interface FeishuSender {
  readonly configured: boolean;
  send(job: { idempotencyKey: string; notice: FeishuNotice }): Promise<void>;
}
/** 默认发送器：没有接入飞书，也没有人授权对外发送，所以什么都发不出去。 */
export class UnconfiguredFeishuSender implements FeishuSender {
  readonly configured = false;
  async send(): Promise<void> { throw new Error('还没有接入飞书'); }
}

@Injectable()
export class FeishuNoticeService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly log = new Logger('Feishu');

  constructor(@InjectDataSource() private readonly ds: DataSource, @Optional() @Inject(FEISHU_SENDER) private sender: FeishuSender = new UnconfiguredFeishuSender()) {}

  setSender(s: FeishuSender) { this.sender = s; }
  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.OUTBOX_WORKER === 'off') return;
    this.timer = setInterval(() => void this.processAll(), 30_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async getSwitch(companyId: number) {
    const row = await this.ds.manager.findOne(OutboxSwitch, { where: { companyId, channel: FEISHU_CHANNEL } });
    return { enabled: row?.enabled ?? false, note: row?.note ?? null, senderConfigured: this.sender.configured };
  }

  async setSwitch(user: AuthUser, enabled: boolean, note?: string) {
    if (!user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员能开关飞书通知');
    await this.ds.query(
      'INSERT INTO outbox_switches (company_id, channel, enabled, note, updated_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), note = VALUES(note), updated_by = VALUES(updated_by)',
      [user.companyId, FEISHU_CHANNEL, enabled ? 1 : 0, note?.slice(0, 200) ?? null, user.id]);
    return this.getSwitch(user.companyId);
  }

  /** 队列概况（待发/已发/失败条数），给开关旁边的说明用 */
  async counts(companyId: number) {
    const rows = await this.ds.query('SELECT status, COUNT(*) AS n FROM outbox_jobs WHERE company_id = ? AND channel = ? GROUP BY status', [companyId, FEISHU_CHANNEL]);
    return Object.fromEntries((rows as { status: string; n: string }[]).map((r) => [r.status, Number(r.n)]));
  }

  /** 加入队列（和业务在同一个事务里）。开关关着就什么都不入，免得开关一打开就把旧通知全发出去。 */
  async enqueue(em: EntityManager, companyId: number, templateKey: string, key: string, notice: FeishuNotice): Promise<boolean> {
    if (!FEISHU_TEMPLATES.includes(templateKey)) return false;
    const sw = await em.findOne(OutboxSwitch, { where: { companyId, channel: FEISHU_CHANNEL } });
    if (!sw?.enabled) return false;
    await em.query(
      'INSERT IGNORE INTO outbox_jobs (company_id, channel, kind, resource_type, resource_id, idempotency_key, payload_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
      [companyId, FEISHU_CHANNEL, 'feishu_notice', 'flow-run', notice.runId ?? 0, `feishu:${key}:${notice.userId}`.slice(0, 120), JSON.stringify({ ...notice, title: notice.title.slice(0, 200), body: notice.body?.slice(0, 500) })]);
    return true;
  }

  async processAll() {
    if (this.running) return;
    this.running = true;
    try {
      const companies = await this.ds.query('SELECT company_id AS id FROM outbox_switches WHERE channel = ? AND enabled = 1', [FEISHU_CHANNEL]);
      for (const c of companies as { id: number }[]) await this.processCompany(c.id);
    } catch (e) { this.log.error(`飞书通知处理失败：${(e as Error).message}`); }
    finally { this.running = false; }
  }

  /** 开关关着、或没有接入真实发送器：一条也不发 */
  async processCompany(companyId: number): Promise<{ sent: number; failed: number; blocked: boolean }> {
    if (!this.sender.configured || !(await this.getSwitch(companyId)).enabled) return { sent: 0, failed: 0, blocked: true };
    const em = this.ds.manager;
    const jobs = await em.createQueryBuilder(OutboxJob, 'j')
      .where("j.company_id = :companyId AND j.channel = :ch AND j.status = 'pending' AND j.next_attempt_at <= NOW()", { companyId, ch: FEISHU_CHANNEL })
      .orderBy('j.id', 'ASC').limit(20).getMany();
    let sent = 0, failed = 0;
    for (const job of jobs) {
      if (!(await this.getSwitch(companyId)).enabled) return { sent, failed, blocked: true };
      const claimed = await em.update(OutboxJob, { id: job.id, status: 'pending' }, { status: 'sending' });
      if (!claimed.affected) continue;
      try {
        await this.sender.send({ idempotencyKey: job.idempotencyKey, notice: job.payloadJson as unknown as FeishuNotice });
        await em.update(OutboxJob, { id: job.id }, { status: 'done', doneAt: new Date(), attempts: job.attempts + 1, lastError: null });
        sent++;
      } catch (e) {
        const attempts = job.attempts + 1;
        await em.update(OutboxJob, { id: job.id }, { status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, lastError: (e as Error).message.slice(0, 500), nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60_000) });
        failed++;
      }
    }
    return { sent, failed, blocked: false };
  }
}
