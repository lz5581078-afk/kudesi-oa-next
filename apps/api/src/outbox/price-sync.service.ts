import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { CostService } from '../resources/cost.service';
import { ResourcesService } from '../resources/resources.service';
import { JST_CHANNEL, OutboxService, PRICE_CHANNEL } from './outbox.service';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const BATCH = 25;

export interface PricePlanRow { bundleId: number; code: string; name: string; action: 'enqueue' | 'blocked' | 'same'; priceCents: number | null; currentCents: number | null; reason: string | null }

/**
 * 最低售价自动同步（旧系统 compose_sale_price）：
 *  成本表算出来的“最低售价”写成聚水潭组合装的基本售价；只改价格，不碰子商品和其他字段（preserveChildPrices）。
 *  - 外部写入：只入出站队列；有独立开关（默认关），总开关关着也不发；
 *  - 只处理已验证、已经成功同步到聚水潭、没有排队中任务、运费/利润率/成本齐全、账号一致的组合；
 *  - 不满足的写“被拦截”和日志，不发送；每次最多 25 个。
 */
@Injectable()
export class PriceSyncService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly log = new Logger('PriceSync');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly outbox: OutboxService,
    private readonly cost: CostService,
    private readonly resources: ResourcesService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.OUTBOX_WORKER === 'off') return;
    this.timer = setInterval(() => void this.autoRun(), 5 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async autoRun() {
    if (this.running) return;
    this.running = true;
    try {
      const cs: { id: number }[] = await this.ds.query("SELECT a.company_id AS id FROM outbox_switches a JOIN outbox_switches b ON b.company_id = a.company_id AND b.channel = ? AND b.enabled = 1 WHERE a.channel = ? AND a.enabled = 1", [JST_CHANNEL, PRICE_CHANNEL]);
      for (const c of cs) await this.run({ id: 0, companyId: c.id, name: '价格同步', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser, { limit: BATCH, auto: true });
    } catch (e) { this.log.error(`基本售价自动同步失败：${(e as Error).message}`); } finally { this.running = false; }
  }

  private need(user: AuthUser) { this.outbox.needBundles(user); }
  private canPrice(user: AuthUser) { return createChecker(user.permissions)('product.price.view'); }

  async getSwitch(user: AuthUser) {
    return this.outbox.getSwitch(user.companyId, PRICE_CHANNEL);
  }
  async setSwitch(user: AuthUser, enabled: boolean, note?: string) {
    return this.outbox.setSwitch(user, enabled, note, PRICE_CHANNEL);
  }

  /** 逐个组合判断能不能同步；不写任何东西 */
  async plan(user: AuthUser, opts: { limit?: number; ids?: number[] } = {}): Promise<PricePlanRow[]> {
    this.need(user);
    const d = await this.cost.load(user.companyId);
    const pending: { resource_id: number }[] = await this.ds.query("SELECT DISTINCT resource_id FROM outbox_jobs WHERE company_id = ? AND resource_type = 'finance-bundles' AND status IN ('pending', 'sending')", [user.companyId]);
    const busy = new Set(pending.map((p) => Number(p.resource_id)));
    const out: PricePlanRow[] = [];
    const candidates = d.bundles.filter((b) => b.status === 'verified' && b.data.jstStatus === 'synced' && (!opts.ids?.length || opts.ids.includes(b.id))).sort((a, b) => a.id - b.id);
    for (const b of candidates) {
      if (out.length >= (opts.limit ?? BATCH)) break;
      const row = this.cost.row(d, b);
      const code = str(b.data.code);
      const cur = typeof b.data.jstPriceCents === 'number' ? b.data.jstPriceCents : null;
      const base = { bundleId: b.id, code, name: str(b.data.name), priceCents: row.minPriceCents, currentCents: cur };
      const block = (reason: string) => out.push({ ...base, action: 'blocked', reason });
      if (str(b.data.jstUploadedCode) !== code) { block('聚水潭上的编码和现在的编码不一致，请先把组合同步上去'); continue; }
      if (busy.has(b.id)) { block('这个组合在同步队列里还有没处理完的任务'); continue; }
      if (row.minPriceCents === null || row.freightCents === null || row.marginPercent === null || row.preShipCostCents === null) { block(row.issues.join('；') || '运费、利润率或成本不齐，算不出最低售价'); continue; }
      if (row.minPriceCents <= 0) { block('算出的最低售价不是正数'); continue; }
      const lastTarget = await this.lastTarget(user.companyId, b.id);
      if (lastTarget && this.outbox.senderTargetKey && lastTarget !== this.outbox.senderTargetKey) { block('这个组合上传时的聚水潭账号和现在连接的不一致'); continue; }
      if (cur === row.minPriceCents && b.data.jstPriceStatus === 'success') { out.push({ ...base, action: 'same', reason: null }); continue; }
      out.push({ ...base, action: 'enqueue', reason: null });
    }
    return out;
  }

  private async lastTarget(companyId: number, bundleId: number): Promise<string | null> {
    const rows: { payload_json: Record<string, unknown> | string }[] = await this.ds.query(
      "SELECT payload_json FROM outbox_jobs WHERE company_id = ? AND resource_type = 'finance-bundles' AND resource_id = ? AND status = 'done' AND kind IN ('bundle_upsert', 'bundle_replace') ORDER BY id DESC LIMIT 1", [companyId, bundleId]);
    if (!rows[0]) return null;
    const p = typeof rows[0].payload_json === 'string' ? JSON.parse(rows[0].payload_json) : rows[0].payload_json;
    return str(p.targetKey) || null;
  }

  private async log_(companyId: number, bundleId: number, status: string, priceCents: number | null, message: string, jobId: number | null = null) {
    await this.ds.query('INSERT INTO bundle_price_logs (company_id, bundle_id, status, price_cents, message, outbox_job_id) VALUES (?, ?, ?, ?, ?, ?)', [companyId, bundleId, status, priceCents, message.slice(0, 800), jobId]);
  }

  /** 预览：只算，不入队 */
  async preview(user: AuthUser, limit?: number) {
    const rows = await this.plan(user, { limit });
    const canPrice = this.canPrice(user);
    return { rows: rows.map((r) => (canPrice ? r : { ...r, priceCents: null, currentCents: null })) };
  }

  /** 执行：入队（不发送）。价格开关没开时拒绝。 */
  async run(user: AuthUser, opts: { limit?: number; ids?: number[]; auto?: boolean } = {}) {
    this.need(user);
    if (!(await this.outbox.getSwitch(user.companyId, PRICE_CHANNEL)).enabled) {
      if (opts.auto) return { queued: 0, blocked: 0, same: 0 };
      throw new ConflictException('基本售价同步开关还没开（只有公司管理员能开）');
    }
    const limit = Math.min(opts.limit ?? BATCH, BATCH);
    const rows = await this.plan(user, { limit, ids: opts.ids });
    let queued = 0, blocked = 0, same = 0;
    for (const r of rows) {
      if (r.action === 'same') { same++; continue; }
      if (r.action === 'blocked') {
        blocked++;
        const [b] = await this.ds.query('SELECT json_unquote(json_extract(data, "$.jstPriceStatus")) AS s FROM resource_records WHERE company_id = ? AND id = ?', [user.companyId, r.bundleId]);
        if (b?.s !== 'blocked' || !opts.auto) {
          await this.ds.transaction((tx) => this.resources.patchData(tx, user, 'finance-bundles', r.bundleId, { jstPriceStatus: 'blocked' }, '基本售价同步被拦截'));
          await this.log_(user.companyId, r.bundleId, 'blocked', r.priceCents, r.reason ?? '');
        }
        continue;
      }
      const cents = r.priceCents as number;
      const baseKey = `price:${r.bundleId}:${cents}`;
      const prior: { idempotency_key: string; status: string }[] = await this.ds.query("SELECT idempotency_key, status FROM outbox_jobs WHERE company_id = ? AND kind = 'bundle_price_update' AND resource_id = ? AND (idempotency_key = ? OR idempotency_key LIKE ?) ORDER BY id DESC", [user.companyId, r.bundleId, baseKey, `${baseKey}:%`]);
      // 同一个价格已经有一条在排队/成功：不重复；失败/取消的才允许换新键重来
      if (prior.some((p) => ['pending', 'sending', 'done'].includes(p.status)) && r.currentCents === cents) { same++; continue; }
      if (prior.some((p) => ['pending', 'sending'].includes(p.status))) { same++; continue; }
      const key = prior.length ? `${baseKey}:${prior.length}` : baseKey;
      const targetKey = this.outbox.senderTargetKey;
      const payload = { sku_id: r.code, code: r.code, compose_sale_price: cents / 100, priceCents: cents, preserveChildPrices: true, ...(targetKey ? { targetKey } : {}) };
      const res = await this.ds.query('INSERT IGNORE INTO outbox_jobs (company_id, channel, kind, resource_type, resource_id, idempotency_key, payload_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [user.companyId, JST_CHANNEL, 'bundle_price_update', 'finance-bundles', r.bundleId, key, JSON.stringify(payload), user.id || null]);
      if (!res.affectedRows) { same++; continue; }
      queued++;
      await this.ds.transaction((tx) => this.resources.patchData(tx, user, 'finance-bundles', r.bundleId, { jstPriceStatus: 'confirming' }, '基本售价已加入同步队列'));
      await this.log_(user.companyId, r.bundleId, 'queued', cents, '最低售价已加入同步队列', Number(res.insertId) || null);
    }
    return { queued, blocked, same };
  }

  async logs(user: AuthUser, q: { bundleId?: number; page: number; pageSize: number }) {
    this.need(user);
    const where = ['l.company_id = ?']; const args: unknown[] = [user.companyId];
    if (q.bundleId) { where.push('l.bundle_id = ?'); args.push(q.bundleId); }
    const [{ n }] = await this.ds.query(`SELECT COUNT(*) AS n FROM bundle_price_logs l WHERE ${where.join(' AND ')}`, args);
    const rows = await this.ds.query(
      `SELECT l.id, l.bundle_id AS bundleId, r.title AS bundleName, l.status, l.price_cents AS priceCents, l.message, l.outbox_job_id AS outboxJobId, l.created_at AS createdAt
       FROM bundle_price_logs l LEFT JOIN resource_records r ON r.id = l.bundle_id AND r.company_id = l.company_id WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    const canPrice = this.canPrice(user);
    return { total: Number(n), page: q.page, pageSize: q.pageSize, rows: canPrice ? rows : rows.map((r: Record<string, unknown>) => ({ ...r, priceCents: null })) };
  }
}
