import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { OutboxJob, OutboxSwitch, ResourceRecord } from '../entities';
import { ResourcesService } from '../resources/resources.service';
import { baseCodeOutbound, sigOf, stripOutboundCost } from '../resources/base-code-support';
import { createChecker, SPECIAL_PERMISSIONS } from '@kudesi/shared';
import { afterJobDone, afterJobFailed, afterJobSent, beforeJobSend, type JobOutcome } from './outbox-handlers';

export const JST_CHANNEL = 'jushuitan';
/** 组合基本售价自动同步的独立开关（外部写入，默认关；总开关关着时同样不发送） */
export const PRICE_CHANNEL = 'jst_price';
export const OUTBOX_SENDER = 'OUTBOX_SENDER';
const MAX_ATTEMPTS = 5;
const SYNCABLE = ['finance-base-codes', 'finance-bundles'] as const;
type Syncable = (typeof SYNCABLE)[number];

export interface RemoteCategory { id: string; name: string; parentId: string; sort: number | null; enable: boolean | null }
export interface OutboxSender {
  /** 没有接入真实接口时为 false：worker 不会发送任何东西 */
  readonly configured: boolean;
  /** 写入成功后仅重试回查，等待第三方查询索引更新；不会重发写入。 */
  readonly confirmationDelays?: readonly number[];
  forCompany?(companyId: number): Promise<OutboxSender>;
  /** 发送器连着哪个聚水潭账号（有值时：入队时写进任务，发送前核对；换了账号的旧任务不会发错地方） */
  readonly targetKey?: string;
  send(job: { kind: string; idempotencyKey: string; payload: Record<string, unknown> }): Promise<void | { remoteId?: string }>;
  /** 读聚水潭上现有的商品分类（分类同步用）；不支持就不提供，分类同步只按上次同步记录比对 */
  readCategories?(): Promise<RemoteCategory[]>;
  /** 回读：按款式/商品编码读出聚水潭上现在的内容（组合装含 childList），用来确认写入结果；读不到返回 null */
  read?(skuId: string, kind?: string): Promise<Record<string, unknown> | null>;
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

  /** 组合装的同步维护：公司管理员，或被授予「组合装同步维护」权限的人（个人拒绝优先）；基础编码和总开关仍只有管理员 */
  canBundles(user: AuthUser) { return createChecker(user.permissions)(SPECIAL_PERMISSIONS.financeBundleSync); }
  needBundles(user: AuthUser) {
    if (!this.canBundles(user)) throw new ForbiddenException('没有「组合装同步维护」的权限');
  }
  private needFor(user: AuthUser, type: string) { if (type === 'finance-bundles') this.needBundles(user); else this.admin(user); }

  async senderFor(companyId: number) { return this.sender.forCompany ? this.sender.forCompany(companyId) : this.sender; }

  get senderTargetKey() { return this.sender.targetKey ?? null; }
  get senderRead() { return this.sender.read ? (id: string) => this.sender.read!(id) : null; }
  get senderReadCategories() { return this.sender.readCategories ? () => this.sender.readCategories!() : null; }

  async getSwitch(companyId: number, channel: string = JST_CHANNEL) {
    const row = await this.dataSource.manager.findOne(OutboxSwitch, { where: { companyId, channel } });
    let senderConfigured = false;
    try { senderConfigured = (await this.senderFor(companyId)).configured; } catch { /* 缺少公司授权 */ }
    return { enabled: row?.enabled ?? false, note: row?.note ?? null, updatedAt: row?.updatedAt ?? null, senderConfigured };
  }

  /** 总开关（channel=jushuitan）和基本售价同步开关（channel=jst_price）都只有公司管理员能改；总开关关着，什么都不发 */
  async setSwitch(user: AuthUser, enabled: boolean, note?: string, channel: string = JST_CHANNEL) {
    this.admin(user);
    await this.dataSource.manager.query(
      'INSERT INTO outbox_switches (company_id, channel, enabled, note, updated_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), note = VALUES(note), updated_by = VALUES(updated_by)',
      [user.companyId, channel, enabled ? 1 : 0, note?.slice(0, 200) ?? null, user.id]);
    return this.getSwitch(user.companyId, channel);
  }

  private async payloadFor(type: Syncable, rec: ResourceRecord): Promise<Record<string, unknown>> {
    if (type === 'finance-base-codes') {
      const out = await baseCodeOutbound(this.dataSource.manager, rec.companyId, rec);
      return { ...out, code: out.sku_id, productId: rec.data.productId ?? null };
    }
    const em = this.dataSource.manager;
    const mine = (await em.find(ResourceRecord, { where: { companyId: rec.companyId, type: 'finance-bundle-lines' } })).filter((l) => l.data.bundleId === rec.id).sort((a, b) => Number(a.data.sortOrder ?? 0) - Number(b.data.sortOrder ?? 0) || a.id - b.id);
    const bcs = mine.length ? await em.find(ResourceRecord, { where: { companyId: rec.companyId, type: 'finance-base-codes', id: In(mine.map((l) => Number(l.data.baseCodeId) || 0)) } }) : [];
    const byId = new Map(bcs.map((b) => [b.id, b]));
    // 子商品用真实编码（马甲指向的那个）；只有「进聚水潭」的行；同一个子商品数量合并
    const child = new Map<string, number>();
    const childRefs: { code: string; baseCodeId: number }[] = [];
    for (const l of mine) {
      if (l.data.role === 'labor' || l.data.includeInJst === false) continue;
      const bc = byId.get(Number(l.data.baseCodeId));
      if (!bc) continue;
      const real = typeof bc.data.canonicalId === 'number' ? (await em.findOne(ResourceRecord, { where: { id: bc.data.canonicalId, companyId: rec.companyId, type: 'finance-base-codes' } })) ?? bc : bc;
      const c = str(real.data.code);
      child.set(c, (child.get(c) ?? 0) + Number(l.data.qty || 0));
      if (!childRefs.some((x) => x.code === c)) childRefs.push({ code: c, baseCodeId: real.id });
    }
    const out: Record<string, unknown> = {
      sku_id: str(rec.data.code), code: str(rec.data.code), i_id: str(rec.data.styleCode), name: str(rec.data.name), short_name: str(rec.data.shortName),
      properties_value: str(rec.data.propertiesValue), unit: str(rec.data.baseUnit),
      childList: [...child].map(([src_sku_id, qty]) => ({ src_sku_id, qty })),
      lines: mine.map((l) => ({ role: str(l.data.role), baseCode: byId.get(Number(l.data.baseCodeId))?.data.code ?? null, qty: l.data.qty })),
    };
    if (typeof rec.data.jstPriceCents === 'number') out.compose_sale_price = rec.data.jstPriceCents / 100;
    return out;
  }

  /** 组合装上传前的依赖检查：子商品必须已经在聚水潭上（上传成功过），否则聚水潭会拒绝 */
  private async childProblems(rec: ResourceRecord): Promise<string[]> {
    const em = this.dataSource.manager;
    const out: string[] = [];
    const payload = await this.payloadFor('finance-bundles', rec);
    if (!str(payload.i_id)) out.push('款式编码为空');
    if (!str(payload.properties_value)) out.push('规格值为空');
    const kids = payload.childList as { src_sku_id: string; qty: number }[];
    if (!kids.length) out.push('没有可上传的子商品');
    for (const k of kids) {
      const bc = await em.findOne(ResourceRecord, { where: { companyId: rec.companyId, type: 'finance-base-codes', uniqueKey: k.src_sku_id.toLowerCase() } });
      if (!bc || !str(bc.data.jstUploadedCode)) out.push(`子商品「${k.src_sku_id}」还没有上传到聚水潭`);
      if (!(Number.isSafeInteger(k.qty) && k.qty > 0)) out.push(`子商品「${k.src_sku_id}」数量不是正整数`);
    }
    return out;
  }

  /** 对外上传内容的指纹：核对时看到的内容和真正入队的内容必须一致 */
  async uploadSignature(rec: ResourceRecord): Promise<string> {
    return sigOf(JSON.stringify(await this.payloadFor(rec.type as Syncable, rec)));
  }

  /** 把已验证、还没同步的基础编码/组合加入队列（也可以只传 ids）；只入队，不发送。改过编码的要先确认旧码已处理。 */
  async enqueue(user: AuthUser, type: string, ids?: number[], opts: { replaceConfirmed?: boolean; signatures?: Record<number, string> } = {}) {
    this.needFor(user, type);
    if (!SYNCABLE.includes(type as Syncable)) throw new BadRequestException('这种资料不支持同步到聚水潭');
    const t = type as Syncable;
    const sender = await this.senderFor(user.companyId);
    const em = this.dataSource.manager;
    const recs = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: t, status: 'verified', ...(ids?.length ? { id: In(ids) } : {}) } });
    let queued = 0, skipped = 0;
    for (const r of recs) {
      if (!ids?.length && r.data.jstStatus === 'synced') { skipped++; continue; }
      const payload = await this.payloadFor(t, r);
      // 核对时看到的内容和现在要上传的必须一致（页面带来的指纹）
      if (opts.signatures && opts.signatures[r.id] !== sigOf(JSON.stringify(payload))) throw new ConflictException(`「${str(r.data.code)}」的上传内容在核对之后变了，请刷新后重新核对`);
      if (t === 'finance-bundles') {
        const problems = await this.childProblems(r);
        if (problems.length) {
          await this.dataSource.transaction((tx) => this.resources.patchData(tx, user, t, r.id, { jstMessage: problems.join('；').slice(0, 500) }, '上传前检查未通过'));
          if (ids?.length) throw new BadRequestException(`「${str(r.data.code)}」不能上传：${problems.join('；')}`);
          skipped++;
          continue;
        }
      }
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
      if (sender.targetKey) payload.targetKey = sender.targetKey;
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
    const sender = await this.senderFor(user.companyId);
    payload = { ...payload, ...(sender.targetKey ? { targetKey: sender.targetKey } : {}) };
    const res = await this.dataSource.manager.query(
      'INSERT IGNORE INTO outbox_jobs (company_id, channel, kind, resource_type, resource_id, idempotency_key, payload_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [user.companyId, JST_CHANNEL, 'normal_product_upload', 'finance-jst-uploads', recordId, `upload:${recordId}`, JSON.stringify(payload), user.id]);
    return { queued: !!res.affectedRows };
  }

  /** 资料被删除/归档后，通知聚水潭停用它之前上传过的编码（只入队）。没传过的不用停用。 */
  async enqueueDisable(user: AuthUser, type: string, id: number, reason: string) {
    this.needFor(user, type);
    if (!SYNCABLE.includes(type as Syncable)) throw new BadRequestException('这种资料不支持同步到聚水潭');
    const em = this.dataSource.manager;
    const r = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type } });
    if (!r) throw new NotFoundException('记录不存在');
    const sender = await this.senderFor(user.companyId);
    const code = str(r.data.jstUploadedCode);
    if (!code) return { queued: false, jobId: null, targetKey: null };
    // 同一个编码上一次的停用任务已经完成（又恢复上传过），这次要用新的幂等键
    const prior: Array<{ n: string }> = await em.query('SELECT COUNT(*) AS n FROM outbox_jobs WHERE company_id = ? AND idempotency_key LIKE ? AND status IN (\'done\', \'cancelled\')', [user.companyId, `disable:${type}:${id}:${code}%`]);
    const suffix = Number(prior[0]?.n ?? 0) > 0 ? `:${prior[0].n}` : '';
    const res = await em.query(
      'INSERT IGNORE INTO outbox_jobs (company_id, channel, kind, resource_type, resource_id, idempotency_key, payload_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [user.companyId, JST_CHANNEL, type === 'finance-base-codes' ? 'base_code_disable' : 'bundle_disable', type, id, `disable:${type}:${id}:${code}${suffix}`, JSON.stringify({ code, sku_id: code, reason: reason.slice(0, 200), ...(sender.targetKey ? { targetKey: sender.targetKey } : {}) }), user.id]);
    const jobs: Array<{ id: number }> = res.affectedRows ? await em.query('SELECT id FROM outbox_jobs WHERE company_id = ? AND idempotency_key = ? LIMIT 1', [user.companyId, `disable:${type}:${id}:${code}${suffix}`]) : [];
    return { queued: !!res.affectedRows, jobId: jobs[0]?.id ?? null, targetKey: sender.targetKey ?? null };
  }

  // ---------- 组合装归档任务（旧系统 finance_bundle_archive_jobs）：OA 已归档，聚水潭禁用结果可跟踪、可复查 ----------

  async recordArchiveJob(user: AuthUser, b: { id: number; code: string; name: string }, reason: string, disable: { jobId: number | null; targetKey: string | null }) {
    await this.dataSource.query(
      `INSERT INTO bundle_archive_jobs (company_id, bundle_id, actor_id, reason, code, name, status, message, outbox_job_id, target_key, request_json, job_json)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'OA 已归档，等待聚水潭禁用', ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE actor_id = VALUES(actor_id), reason = VALUES(reason), code = VALUES(code), name = VALUES(name), status = 'pending', message = VALUES(message),
         outbox_job_id = VALUES(outbox_job_id), target_key = VALUES(target_key), request_json = VALUES(request_json), job_json = VALUES(job_json)`,
      [user.companyId, b.id, user.id, reason.slice(0, 500), b.code, b.name.slice(0, 300), disable.jobId, disable.targetKey, JSON.stringify({ code: b.code, name: b.name }), JSON.stringify({ rechecks: [] })]);
  }

  async archiveJobs(user: AuthUser) {
    this.needBundles(user);
    const rows = await this.dataSource.query(
      `SELECT j.id, j.bundle_id AS bundleId, j.code, j.name, j.status, j.message, j.reason, j.outbox_job_id AS outboxJobId, j.created_at AS createdAt, u.name AS actorName
       FROM bundle_archive_jobs j LEFT JOIN users u ON u.id = j.actor_id AND u.company_id = j.company_id WHERE j.company_id = ? ORDER BY j.id DESC LIMIT 100`, [user.companyId]);
    return { rows };
  }

  /** 复查：只回读聚水潭看组合装是不是已经停用（不会再发送任何写入）；已停用或聚水潭上已经没有 = 成功 */
  async recheckArchiveJob(user: AuthUser, id: number) {
    this.needBundles(user);
    const [row] = await this.dataSource.query('SELECT * FROM bundle_archive_jobs WHERE company_id = ? AND id = ?', [user.companyId, id]);
    if (!row) throw new NotFoundException('归档记录不存在');
    if (row.status === 'success') return { ok: true, status: 'success', message: row.message as string };
    if (row.status === 'pending') throw new ConflictException('禁用任务还在队列里等待处理，请稍后');
    const sender = await this.senderFor(user.companyId);
    if (!sender.read) throw new ConflictException('还没有接入聚水潭，无法复查禁用结果');
    if (row.target_key && sender.targetKey && row.target_key !== sender.targetKey) throw new ConflictException('聚水潭目标账号已改变，不能复查');
    let got: Record<string, unknown> | null;
    try { got = await sender.read(String(row.code), 'bundle'); } catch (e) { throw new ConflictException(`回读失败：${(e as Error).message}`); }
    const prev = typeof row.job_json === 'string' ? JSON.parse(row.job_json) : row.job_json;
    const job = { ...prev, rechecks: [...(prev?.rechecks ?? []), { actorId: user.id, at: new Date().toISOString(), observed: got ? { enabled: got.enabled ?? null } : null }].slice(-20) };
    const disabled = !got || ['-1', '禁用'].includes(String(got.enabled));
    const message = !got ? 'OA 已归档，聚水潭上没有这个组合装，无需禁用' : disabled ? 'OA 已归档，聚水潭组合装已回查确认禁用' : '复查发现聚水潭上这个组合装仍是启用状态，请到同步队列重试禁用任务，或到聚水潭处理';
    const status = disabled ? 'success' : 'failed';
    await this.dataSource.query('UPDATE bundle_archive_jobs SET status = ?, message = ?, job_json = ? WHERE company_id = ? AND id = ?', [status, message, JSON.stringify(job), user.companyId, id]);
    return { ok: true, status, message };
  }

  /**
   * 同步清单：已验证的基础编码/组合，对照上次真正上传的内容列出差异，
   * 状态：未同步 / 排队中 / 等待回查确认 / 已同步 / 同步失败 / 资料待补齐；每条带自己的同步记录。
   */
  async items(user: AuthUser, q: { type: string; keyword?: string; state?: string; page: number; pageSize: number }) {
    if (!SYNCABLE.includes(q.type as Syncable)) throw new BadRequestException('这种资料不支持同步到聚水潭');
    const t = q.type as Syncable;
    const em = this.dataSource.manager;
    const canCost = createChecker(user.permissions)('product.cost.view');
    const qb = em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t AND r.status = :s', { c: user.companyId, t, s: 'verified' });
    if (q.keyword?.trim()) qb.andWhere('r.searchText LIKE :k', { k: `%${q.keyword.trim().replace(/[%_\\]/g, '\\$&')}%` });
    if (q.state) {
      // 按状态筛选要对全部已验证的资料算一遍状态，再分页（状态由上传记录和差异决定，不能只靠 SQL）
      const all = await qb.clone().orderBy('r.id', 'DESC').getMany();
      const hit: ResourceRecord[] = [];
      for (const r of all) if ((await this.describeItem(user, t, r, canCost, false)).state === q.state) hit.push(r);
      const slice = hit.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
      const rows = [];
      for (const r of slice) rows.push(await this.describeItem(user, t, r, canCost, true));
      return { total: hit.length, page: q.page, pageSize: q.pageSize, rows };
    }
    const total = await qb.getCount();
    const recs = await qb.orderBy('r.id', 'DESC').skip((q.page - 1) * q.pageSize).take(q.pageSize).getMany();
    const out = [];
    for (const r of recs) out.push(await this.describeItem(user, t, r, canCost, true));
    return { total, page: q.page, pageSize: q.pageSize, rows: out };
  }

  /** 一条已验证资料的同步状态；light=true 时只要状态（不带差异内容和记录），用于全量统计 */
  private async describeItem(user: AuthUser, t: Syncable, r: ResourceRecord, canCost: boolean, _full: boolean) {
    const em = this.dataSource.manager;
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
      return {
        id: r.id, type: t, code: str(r.data.code), name: str(r.data.name) || r.title, state, signature: sigOf(JSON.stringify(current)), uploadedCode: oldCode || null,
        replacing: !!oldCode && oldCode !== str(r.data.code),
        current: canCost ? current : stripOutboundCost(current), uploaded: uploaded ? (canCost ? uploaded : stripOutboundCost(uploaded)) : null, diff,
        records: jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, attempts: j.attempts, lastError: j.last_error, createdAt: j.created_at, doneAt: j.done_at })),
      };
  }

  /** 同步清单状态汇总：对全部已验证资料统计（不是当前页） */
  async itemsSummary(user: AuthUser, type: string, keyword?: string) {
    if (!SYNCABLE.includes(type as Syncable)) throw new BadRequestException('这种资料不支持同步到聚水潭');
    const t = type as Syncable;
    const canCost = createChecker(user.permissions)('product.cost.view');
    const qb = this.dataSource.manager.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t AND r.status = :s', { c: user.companyId, t, s: 'verified' });
    if (keyword?.trim()) qb.andWhere('r.searchText LIKE :k', { k: `%${keyword.trim().replace(/[%_\\]/g, '\\$&')}%` });
    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of await qb.orderBy('r.id', 'DESC').getMany()) {
      const { state } = await this.describeItem(user, t, r, canCost, false);
      counts[state] = (counts[state] ?? 0) + 1; total++;
    }
    return { total, counts };
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

  private async jobOwner(user: AuthUser, id: number) {
    const [row] = await this.dataSource.query('SELECT resource_type AS t, kind FROM outbox_jobs WHERE id = ? AND company_id = ?', [id, user.companyId]);
    if (!row) throw new NotFoundException('任务不存在');
    if (row.t === 'finance-bundles') this.needBundles(user); else this.admin(user);
  }

  async retry(user: AuthUser, id: number) {
    await this.jobOwner(user, id);
    const r = await this.dataSource.query("UPDATE outbox_jobs SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL WHERE id = ? AND company_id = ? AND status IN ('failed', 'cancelled')", [id, user.companyId]);
    if (!r.affectedRows) throw new ConflictException('只有失败或已取消的任务能重试');
    return { ok: true };
  }

  async cancel(user: AuthUser, id: number) {
    await this.jobOwner(user, id);
    const r = await this.dataSource.manager.update(OutboxJob, { id, companyId: user.companyId, status: In(['pending', 'failed']) as never }, { status: 'cancelled' });
    if (!r.affected) throw new NotFoundException('任务不存在，或已经发送/正在发送');
    return { ok: true };
  }

  private async enabled(companyId: number) {
    return (await this.getSwitch(companyId)).enabled;
  }

  /** 发送后回读确认：组合装的子商品列表、基本售价、禁用状态要和上传的一致 */
  private async confirm(job: OutboxJob, result?: JobOutcome, sender: OutboxSender = this.sender): Promise<void> {
    const delays = sender.confirmationDelays ?? [];
    for (let attempt = 0; ; attempt++) {
      try { return await this.confirmOnce(job, result, sender); }
      catch (error) {
        if (attempt >= delays.length) throw error;
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  private async confirmOnce(job: OutboxJob, result: JobOutcome | undefined, sender: OutboxSender): Promise<void> {
    if (job.kind === 'category_sync') return this.confirmCategory(job, result, sender);
    if (!sender.read) return;
    if (job.resourceType !== 'finance-bundles' && ['base_code_upsert', 'base_code_replace', 'base_code_disable', 'normal_product_upload'].includes(job.kind)) {
      const p = { ...job.payloadJson } as Record<string, unknown>;
      for (const [camel, key] of Object.entries({ shortName: 'short_name', propertiesValue: 'properties_value', categoryName: 'c_name', costPrice: 'cost_price', purchasePrice: 'purchase_price' })) if (p[key] == null && p[camel] != null) p[key] = p[camel];
      const got = await sender.read(str(p.sku_id), 'normal');
      if (job.kind === 'base_code_disable') { if (got && !['-1', '禁用'].includes(String(got.enabled))) throw new Error('普通商品禁用结果未确认'); return; }
      if (!got) throw new Error('回读不到刚上传的普通商品，请人工核对');
      for (const k of ['sku_id', 'i_id', 'name', 'short_name', 'properties_value', 'c_name', 'brand', 'unit', 'weight', 'cost_price', 'purchase_price']) {
        if (p[k] == null) continue;
        const same = ['weight', 'cost_price', 'purchase_price'].includes(k) ? Number(got[k]) === Math.round(Number(p[k]) * 1000000) / 1000000 : (String(got[k] ?? '') === String(p[k]) || (k === 'c_name' && String(got[k] ?? '') === String(p[k]).split('/').at(-1)));
        if (!same) throw new Error(`普通商品回读字段 ${k} 不一致，请人工核对`);
      }
      return;
    }
    const bundleKinds = ['bundle_upsert', 'bundle_replace', 'bundle_price_update', 'bundle_disable'];
    if (job.resourceType !== 'finance-bundles' || !bundleKinds.includes(job.kind)) return;
    const p = job.payloadJson as Record<string, unknown>;
    let got: Record<string, unknown> | null;
    try { got = await sender.read(str(p.sku_id), 'bundle'); } catch (e) { throw new Error(`回读失败，结果未知，请先到聚水潭确认再决定是否重传：${(e as Error).message}`); }
    if (job.kind === 'bundle_disable') {
      // 聚水潭上已经没有这个组合装，或者已经是禁用状态，都算停用成功
      if (got && !['-1', '禁用'].includes(String(got.enabled))) throw new Error('回读发现聚水潭上这个组合装还是启用状态，禁用结果未确认，请到聚水潭核对');
      return;
    }
    if (!got) throw new Error('回读不到刚上传的组合装，结果未知，请先到聚水潭确认');
    if (job.kind === 'bundle_price_update') {
      if (Math.round(Number(got.compose_sale_price) * 100) !== Number(p.priceCents)) throw new Error('回读的基本售价和写入的不一致，结果未知，请到聚水潭确认');
      return;
    }
    const norm = (v: unknown) => JSON.stringify(((v as { src_sku_id: string; qty: number }[]) ?? []).map((c) => [c.src_sku_id, Number(c.qty)]).sort());
    if (norm(got.childList) !== norm(p.childList)) throw new Error('回读的子商品和上传的不一致，请到聚水潭确认');
  }

  /** 分类写入后回读：聚水潭上的分类要和写入的一致；刚停用的分类聚水潭可能不再返回，算正常 */
  private async confirmCategory(job: OutboxJob, result?: JobOutcome, sender: OutboxSender = this.sender): Promise<void> {
    if (!sender.readCategories) return;
    const p = job.payloadJson as Record<string, unknown>;
    const id = result?.remoteId ?? str(p.remoteId);
    if (!id) throw new Error('聚水潭没有返回分类 ID，请人工回查');
    if (str(p.remoteId) && id !== str(p.remoteId)) throw new Error('聚水潭返回的分类 ID 和关联的不一致，请人工回查');
    let all: RemoteCategory[];
    try { all = await sender.readCategories(); } catch (e) { throw new Error(`回读失败，结果未知，请先到聚水潭确认：${(e as Error).message}`); }
    const got = all.find((c) => c.id === id);
    // 实际发出去的内容（上级 ID 已补全）记在关联表的 pending_json 里
    const [lk] = await this.dataSource.query('SELECT pending_json FROM jst_category_links WHERE company_id = ? AND category_id = ? AND target_key = ?', [job.companyId, job.resourceId, str(p.targetKey) || 'default']);
    const sent = lk?.pending_json ? (typeof lk.pending_json === 'string' ? JSON.parse(lk.pending_json) : lk.pending_json) : null;
    if (!sent) throw new Error('找不到这次写入的记录，结果未知，请人工回查');
    const d = sent as { name?: string; sort?: number | null; enable?: boolean; parentId?: string };
    if (!got) { if (d.enable === false) return; throw new Error('回读不到刚写入的分类，结果未知，请人工回查'); }
    const bad = got.name !== d.name || got.parentId !== (d.parentId ?? '0') || (got.sort != null && got.sort !== d.sort) || (got.enable != null && got.enable !== d.enable);
    if (bad) throw new Error('聚水潭写入后回查不一致，请人工核对');
  }

  private get hookCtx() { return { ds: this.dataSource, resources: this.resources }; }

  async priceEnabled(companyId: number) {
    const row = await this.dataSource.manager.findOne(OutboxSwitch, { where: { companyId, channel: PRICE_CHANNEL } });
    return row?.enabled ?? false;
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
    let sender = await this.senderFor(companyId);
    if (!sender.configured || !(await this.enabled(companyId))) return { sent: 0, failed: 0, blocked: true };
    const em = this.dataSource.manager;
    // 基本售价同步有自己的开关：关着时这类任务留在队列里不发送
    const priceOn = await this.priceEnabled(companyId);
    const jobQb = em.createQueryBuilder(OutboxJob, 'j')
      .where("j.company_id = :companyId AND j.channel = :ch AND j.status = 'pending' AND j.next_attempt_at <= NOW()", { companyId, ch: JST_CHANNEL });
    if (!priceOn) jobQb.andWhere("j.kind <> 'bundle_price_update'");
    const jobs = await jobQb.orderBy('j.id', 'ASC').limit(20).getMany();
    let sent = 0, failed = 0;
    const sys = { id: 0, companyId, name: '同步队列', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser;
    for (const job of jobs) {
      if (!(await this.enabled(companyId))) return { sent, failed, blocked: true }; // 中途被关掉：立刻停
      sender = await this.senderFor(companyId);
      const claimed = await em.update(OutboxJob, { id: job.id, status: 'pending' }, { status: 'sending' });
      if (!claimed.affected) continue;
      const target = str((job.payloadJson as Record<string, unknown>).targetKey);
      if (target && sender.targetKey && target !== sender.targetKey) {
        await em.update(OutboxJob, { id: job.id }, { status: 'cancelled', lastError: '入队时的聚水潭账号和现在连接的账号不一致，已取消，请重新加入队列' });
        failed++;
        continue;
      }
      let sendOk = false;
      const hook = { ...this.hookCtx, sys };
      try {
        const payload = await beforeJobSend(hook, job);
        const result = (await sender.send({ kind: job.kind, idempotencyKey: job.idempotencyKey, payload })) ?? undefined;
        sendOk = true;
        await afterJobSent(hook, job);
        await this.confirm(job, result as JobOutcome | undefined, sender);
        await em.update(OutboxJob, { id: job.id }, { status: 'done', doneAt: new Date(), attempts: job.attempts + 1, lastError: null });
        if (job.resourceType === 'finance-jst-uploads') {
          await this.dataSource.transaction((tx) => this.resources.setStatusDirect(tx, sys, job.resourceType, job.resourceId, 'success', '已上传到聚水潭'));
          sent++;
          continue;
        }
        if (await afterJobDone(hook, job, result as JobOutcome | undefined)) { sent++; continue; }
        const sentCode = str((job.payloadJson as Record<string, unknown>).sku_id) || str((job.payloadJson as Record<string, unknown>).code);
        const patch = job.kind.endsWith('_disable') ? { jstUploadedCode: null } : { jstStatus: 'synced', jstUploadedCode: sentCode || null };
        await this.dataSource.transaction((tx) => this.resources.patchData(tx, sys, job.resourceType, job.resourceId, patch, job.kind.endsWith('_disable') ? '聚水潭已停用旧编码' : '已同步到聚水潭'));
        sent++;
      } catch (e) {
        // 已经发出去、但回读确认失败/对不上：结果未知，绝不自动重发
        const unknown = sendOk || Boolean((e as { outcomeUnknown?: boolean }).outcomeUnknown);
        const attempts = job.attempts + 1;
        const dead = unknown || attempts >= MAX_ATTEMPTS;
        // 价格、分类、禁用这几类任务有自己的结果落点，不碰组合的上传状态
        if (['bundle_price_update', 'category_sync'].includes(job.kind) || (job.kind === 'bundle_disable' && unknown)) {
          await em.update(OutboxJob, { id: job.id }, { status: dead ? 'failed' : 'pending', attempts, lastError: (e as Error).message.slice(0, 500), nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60_000) });
          await afterJobFailed(hook, job, (e as Error).message, unknown, dead);
          failed++;
          continue;
        }
        if (unknown && job.resourceType !== 'finance-jst-uploads') await this.dataSource.transaction((tx) => this.resources.patchData(tx, sys, job.resourceType, job.resourceId, { jstMessage: `结果未知：${(e as Error).message}`.slice(0, 500) }, '回读确认未通过'));
        await em.update(OutboxJob, { id: job.id }, { status: dead ? 'failed' : 'pending', attempts, lastError: (e as Error).message.slice(0, 500), nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60_000) });
        if (dead && job.resourceType === 'finance-jst-uploads') await this.dataSource.transaction(async (tx) => {
          await this.resources.patchData(tx, sys, job.resourceType, job.resourceId, { message: (e as Error).message.slice(0, 300) }, '上传聚水潭失败');
          await this.resources.setStatusDirect(tx, sys, job.resourceType, job.resourceId, 'failed', '上传聚水潭失败');
        });
        else if (dead) {
          await this.dataSource.transaction((tx) => this.resources.patchData(tx, sys, job.resourceType, job.resourceId, { jstStatus: 'failed' }, '同步聚水潭失败'));
          await afterJobFailed(hook, job, (e as Error).message, unknown, dead);
        }
        failed++;
      }
    }
    return { sent, failed, blocked: false };
  }
}
