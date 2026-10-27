import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { OutboxJob, OutboxSwitch, ResourceRecord } from '../entities';
import { ResourcesService } from '../resources/resources.service';
import { baseCodeOutbound, sigOf, stripOutboundCost } from '../resources/base-code-support';
import { createChecker } from '@kudesi/shared';

export const JST_CHANNEL = 'jushuitan';
export const OUTBOX_SENDER = 'OUTBOX_SENDER';
const MAX_ATTEMPTS = 5;
const SYNCABLE = ['finance-base-codes', 'finance-bundles'] as const;
type Syncable = (typeof SYNCABLE)[number];

export interface OutboxSender {
  /** 没有接入真实接口时为 false：worker 不会发送任何东西 */
  readonly configured: boolean;
  send(job: { kind: string; idempotencyKey: string; payload: Record<string, unknown> }): Promise<void>;
}

/** 默认发送器：没有接入聚水潭，也没有人授权对外写入，所以什么都发不出去。 */
export class UnconfiguredSender implements OutboxSender {
  readonly configured = false;
  async send(): Promise<void> { throw new Error('还没有接入聚水潭接口'); }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * 出站队列（外部写入的唯一出口）：
 *  - 业务只“加入队列”，不直接调外部接口；
 *  - 总开关默认关，随时可以一键停止；关着的时候队列只积压，不发送；
 *  - 单一 worker 串行发送，失败按 2 的幂次分钟退避，最多重试 5 次；同一个版本只入队一次（幂等键）。
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly log = new Logger('Outbox');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly resources: ResourcesService,
    @Optional() @Inject(OUTBOX_SENDER) private sender: OutboxSender = new UnconfiguredSender(),
  ) {}

  setSender(s: OutboxSender) { this.sender = s; }

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.OUTBOX_WORKER === 'off') return;
    this.timer = setInterval(() => void this.processAll(), 30_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private admin(user: AuthUser) {
    if (!user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员能管理对外同步');
  }

  async getSwitch(companyId: number) {
    const row = await this.dataSource.manager.findOne(OutboxSwitch, { where: { companyId, channel: JST_CHANNEL } });
    return { enabled: row?.enabled ?? false, note: row?.note ?? null, updatedAt: row?.updatedAt ?? null, senderConfigured: this.sender.configured };
  }

  async setSwitch(user: AuthUser, enabled: boolean, note?: string) {
    this.admin(user);
    await this.dataSource.manager.query(
      'INSERT INTO outbox_switches (company_id, channel, enabled, note, updated_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), note = VALUES(note), updated_by = VALUES(updated_by)',
      [user.companyId, JST_CHANNEL, enabled ? 1 : 0, note?.slice(0, 200) ?? null, user.id]);
    return this.getSwitch(user.companyId);
  }

  private async payloadFor(type: Syncable, rec: ResourceRecord): Promise<Record<string, unknown>> {
    if (type === 'finance-base-codes') {
      const out = await baseCodeOutbound(this.dataSource.manager, rec.companyId, rec);
      return { ...out, code: out.sku_id, productId: rec.data.productId ?? null };
    }
    const lines = await this.dataSource.manager.find(ResourceRecord, { where: { companyId: rec.companyId, type: 'finance-bundle-lines' } });
    const mine = lines.filter((l) => l.data.bundleId === rec.id);
    const bcs = mine.length ? await this.dataSource.manager.find(ResourceRecord, { where: { companyId: rec.companyId, type: 'finance-base-codes', id: In(mine.map((l) => Number(l.data.baseCodeId) || 0)) } }) : [];
    const code = new Map(bcs.map((b) => [b.id, str(b.data.code)]));
    return { code: str(rec.data.code), name: str(rec.data.name), lines: mine.map((l) => ({ role: str(l.data.role), baseCode: code.get(Number(l.data.baseCodeId)) ?? null, qty: l.data.qty })) };
  }

  /** 对外上传内容的指纹：核对时看到的内容和真正入队的内容必须一致 */
  async uploadSignature(rec: ResourceRecord): Promise<string> {
    return sigOf(JSON.stringify(await this.payloadFor(rec.type as Syncable, rec)));
  }

  /** 把已验证、还没同步的基础编码/组合加入队列（也可以只传 ids）；只入队，不发送。改过编码的要先确认旧码已处理。 */
  async enqueue(user: AuthUser, type: string, ids?: number[], opts: { replaceConfirmed?: boolean } = {}) {
    this.admin(user);
    if (!SYNCABLE.includes(type as Syncable)) throw new BadRequestException('这种资料不支持同步到聚水潭');
    const t = type as Syncable;
    const em = this.dataSource.manager;
    const recs = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: t, status: 'verified', ...(ids?.length ? { id: In(ids) } : {}) } });
    let queued = 0, skipped = 0;
    for (const r of recs) {
      if (!ids?.length && r.data.jstStatus === 'synced') { skipped++; continue; }
      const payload = await this.payloadFor(t, r);
      // 幂等键 = 记录 + 上传内容指纹：只看内容，不看更新时间（入队后回写状态会改更新时间，跨秒会让同一内容重复入队）。
      // 内容和最近一条非停用任务相同 → 跳过；内容改回以前的版本（A→B→A）→ 键后加序号，允许重发。
      const baseKey = `${t}:${r.id}:${sigOf(JSON.stringify(payload)).slice(0, 16)}`;
      const prior: { idempotency_key: string }[] = await em.query(
        "SELECT idempotency_key FROM outbox_jobs WHERE company_id = ? AND resource_type = ? AND resource_id = ? AND kind NOT LIKE '%\\_disable' ORDER BY id DESC",
        [user.companyId, t, r.id]);
      const sameBase = (k: string) => k === baseKey || k.startsWith(`${baseKey}:`);
      if (prior.length && sameBase(prior[0].idempotency_key)) { skipped++; continue; }
      const key = prior.some((p) => sameBase(p.idempotency_key)) ? `${baseKey}:${prior.filter((p) => sameBase(p.idempotency_key)).length}` : baseKey;
      const old = str(r.data.jstUploadedCode);
      const replacing = !!old && old !== str(r.data.code);
      if (replacing && !opts.replaceConfirmed) {
        if (ids?.length) throw new BadRequestException(`「${str(r.data.code)}」的编码和聚水潭上已有的「${old}」不同，需要先确认旧编码的库存、在途订单、组合装和店铺映射已处理，再改码上传`);
        skipped++;
        continue;
      }
      if (replacing) payload.oldCode = old;
      const kind = t === 'finance-base-codes' ? (replacing ? 'base_code_replace' : 'base_code_upsert') : replacing ? 'bundle_replace' : 'bundle_upsert';
      const res = await em.query(
        'INSERT IGNORE INTO outbox_jobs (company_id, channel, kind, resource_type, resource_id, idempotency_key, payload_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [user.companyId, JST_CHANNEL, kind, t, r.id, key, JSON.stringify(payload), user.id]);
      if (res.affectedRows) {
        queued++;
        await this.dataSource.transaction((tx) => this.resources.patchData(tx, user, t, r.id, { jstStatus: 'pending' }, '加入聚水潭同步队列'));
      } else skipped++;
    }
    if (ids?.length && recs.length < ids.length) throw new BadRequestException('有记录不存在，或还没有验证通过，不能同步');
    return { queued, skipped };
  }

  /** 手工上传的普通商品资料：只加入队列（总开关开着、接入真实接口后才会发送），结果回写上传记录。 */
  async enqueueUpload(user: AuthUser, recordId: number, payload: Record<string, unknown>) {
    this.admin(user);
    const res = await this.dataSource.manager.query(
      'INSERT IGNORE INTO outbox_jobs (company_id, channel, kind, resource_type, resource_id, idempotency_key, payload_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [user.companyId, JST_CHANNEL, 'normal_product_upload', 'finance-jst-uploads', recordId, `upload:${recordId}`, JSON.stringify(payload), user.id]);
    return { queued: !!res.affectedRows };
  }

  /** 资料被删除/归档后，通知聚水潭停用它之前上传过的编码（只入队）。没传过的不用停用。 */
  async enqueueDisable(user: AuthUser, type: string, id: number, reason: string) {
    this.admin(user);
    if (!SYNCABLE.includes(type as Syncable)) throw new BadRequestException('这种资料不支持同步到聚水潭');
    const em = this.dataSource.manager;
    const r = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type } });
    if (!r) throw new NotFoundException('记录不存在');
    const code = str(r.data.jstUploadedCode);
    if (!code) return { queued: false };
    const res = await em.query(
      'INSERT IGNORE INTO outbox_jobs (company_id, channel, kind, resource_type, resource_id, idempotency_key, payload_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [user.companyId, JST_CHANNEL, type === 'finance-base-codes' ? 'base_code_disable' : 'bundle_disable', type, id, `disable:${type}:${id}:${code}`, JSON.stringify({ code, reason: reason.slice(0, 200) }), user.id]);
    return { queued: !!res.affectedRows };
  }

  /**
   * 同步清单：已验证的基础编码/组合，对照上次真正上传的内容列出差异，
   * 状态：未同步 / 排队中 / 等待回查确认 / 已同步 / 同步失败 / 资料待补齐；每条带自己的同步记录。
   */
  async items(user: AuthUser, q: { type: string; keyword?: string; page: number; pageSize: number }) {
    if (!SYNCABLE.includes(q.type as Syncable)) throw new BadRequestException('这种资料不支持同步到聚水潭');
    const t = q.type as Syncable;
    const em = this.dataSource.manager;
    const canCost = createChecker(user.permissions)('product.cost.view');
    const qb = em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t AND r.status = :s', { c: user.companyId, t, s: 'verified' });
    if (q.keyword?.trim()) qb.andWhere('r.searchText LIKE :k', { k: `%${q.keyword.trim().replace(/[%_\\]/g, '\\$&')}%` });
    const total = await qb.getCount();
    const recs = await qb.orderBy('r.id', 'DESC').skip((q.page - 1) * q.pageSize).take(q.pageSize).getMany();
    const out = [];
    for (const r of recs) {
      const current = await this.payloadFor(t, r);
      const jobs: Array<{ id: number; kind: string; status: string; attempts: number; last_error: string | null; created_at: string; done_at: string | null; payload_json: Record<string, unknown> | string }> = await em.query(
        'SELECT id, kind, status, attempts, last_error, created_at, done_at, payload_json FROM outbox_jobs WHERE company_id = ? AND resource_type = ? AND resource_id = ? ORDER BY id DESC LIMIT 10', [user.companyId, t, r.id]);
      const parse = (v: Record<string, unknown> | string) => (typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : v);
      const lastDone = jobs.find((j) => j.status === 'done' && !j.kind.endsWith('_disable'));
      const uploaded = lastDone ? parse(lastDone.payload_json) : null;
      const keys = t === 'finance-base-codes' ? ['sku_id', 'i_id', 'name', 'short_name', 'properties_value', 'c_name', 'brand', 'unit', 'weight', 'cost_price', 'purchase_price'] : ['code', 'name', 'lines'];
      const diff = uploaded ? keys.filter((k) => JSON.stringify(current[k] ?? null) !== JSON.stringify(uploaded[k] ?? null)).filter((k) => canCost || !['cost_price', 'purchase_price'].includes(k)).map((k) => ({ field: k, uploaded: uploaded[k] ?? null, current: current[k] ?? null })) : [];
      const incomplete = t === 'finance-base-codes' && (current.weight === null || current.cost_price === null || !current.c_name || !current.unit);
      const active = jobs[0];
      let state: string;
      if (incomplete) state = 'incomplete';
      else if (active && active.status === 'sending') state = 'confirming';
      else if (active && ['pending'].includes(active.status)) state = 'queued';
      else if (active && active.status === 'failed') state = 'failed';
      else if (uploaded && diff.length === 0 && r.data.jstStatus === 'synced') state = 'synced';
      else state = 'not_synced';
      const oldCode = str(r.data.jstUploadedCode);
      out.push({
        id: r.id, type: t, code: str(r.data.code), name: str(r.data.name) || r.title, state, uploadedCode: oldCode || null,
        replacing: !!oldCode && oldCode !== str(r.data.code),
        current: canCost ? current : stripOutboundCost(current), uploaded: uploaded ? (canCost ? uploaded : stripOutboundCost(uploaded)) : null, diff,
        records: jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, attempts: j.attempts, lastError: j.last_error, createdAt: j.created_at, doneAt: j.done_at })),
      });
    }
    return { total, page: q.page, pageSize: q.pageSize, rows: out };
  }

  async jobs(user: AuthUser, q: { status?: string; kind?: string; page: number; pageSize: number }) {
    const where: string[] = ['j.company_id = ?', 'j.channel = ?'];
    const args: unknown[] = [user.companyId, JST_CHANNEL];
    if (q.status) { where.push('j.status = ?'); args.push(q.status); }
    if (q.kind) { where.push('j.kind LIKE ?'); args.push(`${q.kind.replace(/[%_\\]/g, '\\$&')}%`); }
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n FROM outbox_jobs j WHERE ${where.join(' AND ')}`, args);
    const rows = await this.dataSource.query(
      `SELECT j.id, j.kind, j.resource_type AS resourceType, j.resource_id AS resourceId, j.status, j.attempts, j.last_error AS lastError, j.created_at AS createdAt, j.done_at AS doneAt, j.payload_json AS payload FROM outbox_jobs j WHERE ${where.join(' AND ')} ORDER BY j.id DESC LIMIT ? OFFSET ?`,
      [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    const counts = await this.dataSource.query('SELECT status, COUNT(*) AS n FROM outbox_jobs WHERE company_id = ? AND channel = ? GROUP BY status', [user.companyId, JST_CHANNEL]);
    // 成本价、采购价是敏感信息：没有成本查看权限的人，队列里的上传内容也不带这两项
    const canCost = createChecker(user.permissions)('product.cost.view');
    for (const row of rows as { payload: unknown }[]) {
      const pl = typeof row.payload === 'string' ? (JSON.parse(row.payload) as Record<string, unknown>) : (row.payload as Record<string, unknown> | null);
      if (pl) row.payload = canCost ? pl : stripOutboundCost(pl);
    }
    return { total: Number(n), page: q.page, pageSize: q.pageSize, counts: Object.fromEntries(counts.map((c: { status: string; n: string }) => [c.status, Number(c.n)])), rows };
  }

  async retry(user: AuthUser, id: number) {
    this.admin(user);
    const r = await this.dataSource.query("UPDATE outbox_jobs SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL WHERE id = ? AND company_id = ? AND status IN ('failed', 'cancelled')", [id, user.companyId]);
    if (!r.affectedRows) throw new ConflictException('只有失败或已取消的任务能重试');
    return { ok: true };
  }

  async cancel(user: AuthUser, id: number) {
    this.admin(user);
    const r = await this.dataSource.manager.update(OutboxJob, { id, companyId: user.companyId, status: In(['pending', 'failed']) as never }, { status: 'cancelled' });
    if (!r.affected) throw new NotFoundException('任务不存在，或已经发送/正在发送');
    return { ok: true };
  }

  private async enabled(companyId: number) {
    return (await this.getSwitch(companyId)).enabled;
  }

  /** 处理所有公司的队列（定时调用） */
  async processAll() {
    if (this.running) return;
    this.running = true;
    try {
      const companies = await this.dataSource.query("SELECT company_id AS id FROM outbox_switches WHERE channel = ? AND enabled = 1", [JST_CHANNEL]);
      for (const c of companies as { id: number }[]) await this.processCompany(c.id);
    } catch (e) { this.log.error(`出站队列处理失败：${(e as Error).message}`); }
    finally { this.running = false; }
  }

  /** 开关关着、或没有接入真实发送器：一条也不发 */
  async processCompany(companyId: number): Promise<{ sent: number; failed: number; blocked: boolean }> {
    if (!this.sender.configured || !(await this.enabled(companyId))) return { sent: 0, failed: 0, blocked: true };
    const em = this.dataSource.manager;
    const jobs = await em.createQueryBuilder(OutboxJob, 'j')
      .where("j.company_id = :companyId AND j.channel = :ch AND j.status = 'pending' AND j.next_attempt_at <= NOW()", { companyId, ch: JST_CHANNEL })
      .orderBy('j.id', 'ASC').limit(20).getMany();
    let sent = 0, failed = 0;
    const sys = { id: 0, companyId, name: '同步队列', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser;
    for (const job of jobs) {
      if (!(await this.enabled(companyId))) return { sent, failed, blocked: true }; // 中途被关掉：立刻停
      const claimed = await em.update(OutboxJob, { id: job.id, status: 'pending' }, { status: 'sending' });
      if (!claimed.affected) continue;
      try {
        await this.sender.send({ kind: job.kind, idempotencyKey: job.idempotencyKey, payload: job.payloadJson });
        await em.update(OutboxJob, { id: job.id }, { status: 'done', doneAt: new Date(), attempts: job.attempts + 1, lastError: null });
        if (job.resourceType === 'finance-jst-uploads') {
          await this.dataSource.transaction((tx) => this.resources.setStatusDirect(tx, sys, job.resourceType, job.resourceId, 'success', '已上传到聚水潭'));
          sent++;
          continue;
        }
        const sentCode = str((job.payloadJson as Record<string, unknown>).sku_id) || str((job.payloadJson as Record<string, unknown>).code);
        const patch = job.kind.endsWith('_disable') ? { jstUploadedCode: null } : { jstStatus: 'synced', jstUploadedCode: sentCode || null };
        await this.dataSource.transaction((tx) => this.resources.patchData(tx, sys, job.resourceType, job.resourceId, patch, job.kind.endsWith('_disable') ? '聚水潭已停用旧编码' : '已同步到聚水潭'));
        sent++;
      } catch (e) {
        const attempts = job.attempts + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        await em.update(OutboxJob, { id: job.id }, { status: dead ? 'failed' : 'pending', attempts, lastError: (e as Error).message.slice(0, 500), nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60_000) });
        if (dead && job.resourceType === 'finance-jst-uploads') await this.dataSource.transaction(async (tx) => {
          await this.resources.patchData(tx, sys, job.resourceType, job.resourceId, { message: (e as Error).message.slice(0, 300) }, '上传聚水潭失败');
          await this.resources.setStatusDirect(tx, sys, job.resourceType, job.resourceId, 'failed', '上传聚水潭失败');
        });
        else if (dead) await this.dataSource.transaction((tx) => this.resources.patchData(tx, sys, job.resourceType, job.resourceId, { jstStatus: 'failed' }, '同步聚水潭失败'));
        failed++;
      }
    }
    return { sent, failed, blocked: false };
  }
}
