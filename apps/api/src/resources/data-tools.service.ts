import { lastCompleteCosts, completeCost } from './cost-registration';
import { COST_HISTORY_FIELDS, costHistoryValues } from './cost-history-values';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { packagingRuleMatches, parseDiscreteWeights, type PackagingRule } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Company, FinanceApiKey, FinanceCostSnapshot, FinanceMasterSnapshot, ResourceChangeLog, ResourceLink, ResourceRecord } from '../entities';
import { COST_TABLE_STATUSES, CostService } from './cost.service';
import { COST_EVENT_LABEL, registerCostSnapshots, type CostEvent } from './cost-snapshot';
import { bundleIssues } from './bundle-checks';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export const API_SCOPE = 'verified_bundle_read';
/** 公司商品与成本目录（组合分类、成本分类、SKU 成本、组合编码），只读 */
export const CATALOG_SCOPE = 'company_catalog_read';
export const API_SCOPES = [API_SCOPE, CATALOG_SCOPE] as const;
const KEY_RE = /^kdoa1\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/;

/** 主数据重置的范围：先删下级再删上级；“platforms”那两项可选保留 */
export const RESET_TYPES: Array<{ type: string; label: string; optional?: boolean }> = [
  { type: 'finance-bundle-revisions', label: '组合构成修订' },
  { type: 'finance-bundle-naming-rules', label: '组合命名规则' },
  { type: 'finance-bundle-lines', label: '组合构成' },
  { type: 'finance-bundles', label: '商品组合编码' },
  { type: 'finance-packaging-rules', label: '包装方案匹配规则' },
  { type: 'finance-packaging-lines', label: '包装方案明细' },
  { type: 'finance-packaging-schemes', label: '包装方案' },
  { type: 'finance-base-codes', label: '基础编码' },
  { type: 'finance-product-boms', label: '商品构成（BOM）' },
  { type: 'finance-product-sources', label: '商品供货来源' },
  { type: 'finance-products', label: '商品档案' },
  { type: 'finance-margins', label: '分类利润率' },
  { type: 'finance-categories', label: '商品分类' },
  { type: 'finance-brands', label: '品牌' },
  { type: 'finance-code-dictionaries', label: '商品编码分类与品种字典' },
  { type: 'finance-product-units', label: '商品单位与规格（保留档案类型定义）' },
  { type: 'finance-platforms', label: '销售平台', optional: true },
];

/** 数据板块的小工具：成本历史、包装方案匹配试算、API 密钥、主数据重置 */
@Injectable()
export class DataToolsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly cost: CostService) {}

  private admin(user: AuthUser) {
    if (!user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员能做这个操作');
  }

  // ---------- 成本历史 ----------
  /** 登记成本快照：和上一次相比没变就不记。bundleId 不传 = 所有已验证的组合。 */
  /** 补齐先预览，只包含缺少登记且当前资料完整的已验证SKU。 */
  async previewCostRegistration(user: AuthUser, em: EntityManager = this.dataSource.manager) {
    const { d, rows: current } = await this.cost.liveAllRows(user, em);
    const present = await lastCompleteCosts(em, user.companyId, current.map(row => row.bundleId));
    const rows: Array<{ id: number; code: string; name: string; costCents: number; weightG: number }> = [];
    const issues: Array<{ id: number; code: string; issues: string[] }> = [];
    const versions: unknown[] = [];
    for (const row of current.filter(row => row.status === 'verified' && !present.has(row.bundleId)).sort((a,b) => a.bundleId - b.bundleId)) {
      const problems: string[] = [...row.issues];
      if (!completeCost(row) && !problems.length) problems.push('成本、重量、运费或利润率不完整');
      if (row.preShipCostCents === null || row.preShipCostCents < 0) problems.push('缺少有效总成本');
      if (row.weightG === null || row.weightG <= 0) problems.push('缺少有效重量');
      const lines = d.lines.filter(line => line.data.bundleId === row.bundleId);
      const bundle = d.bundles.find(bundle => bundle.id === row.bundleId)!;
      const platform = await em.findOne(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-platforms', id: Number(bundle.data.platformId) } });
      problems.push(...await bundleIssues(em, user.companyId, bundle.data, lines.map(line => line.data), platform?.status ?? 'missing'));
      versions.push([row.bundleId, bundle.data, row.lines, row.freightCents, row.marginPercent, row.minPriceCents]);
      if (problems.length) issues.push({ id: row.bundleId, code: row.code, issues: problems });
      else rows.push({ id: row.bundleId, code: row.code, name: row.name, costCents: row.preShipCostCents!, weightG: row.weightG! });
    }
    const signature = crypto.createHash('sha256').update(JSON.stringify([user.companyId, rows, issues, versions])).digest('hex');
    return { rows, issues, signature };
  }

  /** 登记成本快照；补齐必须确认预览，已经存在的记录及单品设置不覆盖。 */
  async registerCost(user: AuthUser, bundleId: number | undefined, reason: string, outer?: EntityManager, eventType: CostEvent = 'manual', missingOnly = false, confirmation?: { confirmed?: boolean; signature?: string }): Promise<{ recorded: number; unchanged: number; invalid?: number }> {
    if (!outer) return this.dataSource.transaction(em => this.registerCost(user, bundleId, reason, em, eventType, missingOnly, confirmation));
    const em = outer;
    let ids: number[];
    const locked = await em.find(ResourceRecord, {
      where: { companyId: user.companyId, type: 'finance-bundles', ...(bundleId ? { id: bundleId } : { status: In(missingOnly ? ['verified'] : COST_TABLE_STATUSES) }) },
      order: { id: 'ASC' }, lock: { mode: 'pessimistic_write' },
    });
    if (missingOnly) {
      if (!confirmation?.confirmed || !confirmation.signature) throw new BadRequestException('请先预览并确认补齐');
      // 先锁定本公司的已验证组合，再建立一致性读取，防止同时补齐重复登记。
      if (bundleId && !locked.some(bundle => bundle.id === bundleId && bundle.status === 'verified')) throw new BadRequestException('只能补齐已经验证的SKU');
      const preview = await this.previewCostRegistration(user, em);
      if (preview.signature !== confirmation.signature) throw new ConflictException('预览之后资料已变化，请重新预览再补齐');
      ids = preview.rows.filter(row => !bundleId || row.id === bundleId).map(row => row.id);
    } else ids = bundleId ? [bundleId] : locked.map(bundle => bundle.id);
    const result = await registerCostSnapshots(em, user.companyId, user.id, ids, reason, eventType);
    if (bundleId && result.missing) throw new NotFoundException('组合不存在');
    return { recorded: result.recorded, unchanged: result.unchanged, ...(result.invalid ? { invalid: result.invalid } : {}) };
  }

  async costHistory(user: AuthUser, q: { bundleId?: number; keyword?: string; page: number; pageSize: number }) {
    const where: string[] = ['s.company_id = ?'];
    const args: unknown[] = [user.companyId];
    if (q.bundleId) { where.push('s.bundle_id = ?'); args.push(q.bundleId); }
    if (q.keyword?.trim()) { where.push('(s.code LIKE ? OR s.name LIKE ? OR s.reason LIKE ?)'); args.push(`%${q.keyword.trim()}%`, `%${q.keyword.trim()}%`, `%${q.keyword.trim()}%`); }
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n FROM finance_cost_snapshots s WHERE ${where.join(' AND ')}`, args);
    const rows = await this.dataSource.query(
      `SELECT s.*, u.name AS actorName,
         (SELECT p.id FROM finance_cost_snapshots p WHERE p.company_id = s.company_id AND p.bundle_id = s.bundle_id AND p.id < s.id ORDER BY p.id DESC LIMIT 1) AS prevId
       FROM finance_cost_snapshots s LEFT JOIN users u ON u.id = s.actor_id AND u.company_id = s.company_id
       WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT ? OFFSET ?`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    const prevIds = rows.map((r: { prevId: number | null }) => r.prevId).filter((x: number | null): x is number => !!x);
    const prev = prevIds.length ? await this.dataSource.query(`SELECT * FROM finance_cost_snapshots WHERE company_id = ? AND id IN (${prevIds.map(() => '?').join(',')})`, [user.companyId, ...prevIds]) : [];
    const pm = new Map<number, Record<string, unknown>>(prev.map((p: { id: number }) => [Number(p.id), p]));
    return {
      total: Number(n), page: q.page, pageSize: q.pageSize,
      rows: rows.map((r: Record<string, unknown>) => {
        const p = r.prevId ? pm.get(Number(r.prevId)) : undefined;
        const cur = costHistoryValues(r);
        const before = p ? costHistoryValues(p) : null;
        return { id: r.id, bundleId: r.bundle_id, code: r.code, name: r.name, revision: r.revision, reason: r.reason, eventType: r.event_type, eventLabel: COST_EVENT_LABEL[r.event_type as CostEvent] ?? '手动登记', actorName: r.actorName ?? '系统', createdAt: r.created_at, ...cur,
          before, changes: before ? COST_HISTORY_FIELDS.filter(([key]) => cur[key] !== before[key]).map(([key, label]) => ({ field: key, label, before: before[key], after: cur[key] })) : [] };
      }),
    };
  }

  // ---------- 包装方案匹配试算 ----------
  async packagingMatch(user: AuthUser, t: { usageScene?: string; targetType: 'base_code' | 'bundle' | 'product_archive'; targetCode?: string; categoryId?: number; brandId?: number; scenarioId?: number; weightKg?: number }) {
    const em = this.dataSource.manager;
    const schemes = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-packaging-schemes', status: 'active' } });
    const live = schemes.filter((s) => !t.usageScene || s.data.usageScene === t.usageScene);
    const rules = live.length ? await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-packaging-rules', status: 'active' } }) : [];
    const sm = new Map(live.map((s) => [s.id, s]));
    const hits = rules
      .filter((r) => sm.has(num(r.data.schemeId) ?? -1))
      .map((r) => ({ r, rule: { targetType: (str(r.data.targetType) || 'general') as PackagingRule['targetType'], targetCode: str(r.data.targetCode) || null, categoryId: num(r.data.categoryId), brandId: num(r.data.brandId), scenarioId: num(r.data.scenarioId),
        minWeightKg: num(r.data.minWeightKg), maxWeightKg: num(r.data.maxWeightKg), discreteWeights: parseDiscreteWeights(r.data.discreteWeights), priority: num(r.data.priority) ?? 100 } as PackagingRule }))
      .filter(({ rule }) => packagingRuleMatches(rule, { targetType: t.targetType, targetCode: t.targetCode, categoryId: t.categoryId, brandId: t.brandId, scenarioId: t.scenarioId, weightKg: t.weightKg }))
      .sort((a, b) => a.rule.priority - b.rule.priority || a.r.id - b.r.id);
    const matches = hits.map(({ r, rule }) => ({ ruleId: r.id, schemeId: num(r.data.schemeId), schemeName: sm.get(num(r.data.schemeId) ?? -1)?.title ?? '', priority: rule.priority }));
    let selected: { scheme: { id: number; code: string; name: string; usageScene: string }; lines: Array<{ componentName: string; qty: number; lossRate: number | null; costTreatment: string; costBucket: string }> } | null = null;
    if (hits[0]) {
      const sc = sm.get(num(hits[0].r.data.schemeId) ?? -1)!;
      const lines = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-packaging-lines' } });
      const mine = lines.filter((l) => num(l.data.schemeId) === sc.id).sort((a,b) => (num(a.data.sortOrder) ?? 0) - (num(b.data.sortOrder) ?? 0) || a.id-b.id);
      const comps = mine.length ? await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-products', id: In(mine.map((l) => num(l.data.componentId) ?? 0)) } }) : [];
      const cn = new Map(comps.map((c) => [c.id, c.title]));
      selected = { scheme: { id: sc.id, code: str(sc.data.schemeCode), name: sc.title, usageScene: str(sc.data.usageScene) },
        lines: mine.map((l) => ({ componentName: cn.get(num(l.data.componentId) ?? 0) ?? '', qty: num(l.data.qty) ?? 0, lossRate: num(l.data.lossRate), costTreatment: str(l.data.costTreatment), costBucket: str(l.data.costBucket) })) };
    }
    return {
      selected, matches, ambiguous: matches.length > 1 && matches[0].priority === matches[1].priority,
      issues: matches.length ? [] : [{ level: 'warning', message: '没有匹配到包装方案；按业务规则保持无包装组成，不自动补行' }],
    };
  }

  // ---------- API 密钥 ----------
  async listKeys(user: AuthUser) {
    this.admin(user);
    const rows = await this.dataSource.manager.find(FinanceApiKey, { where: { companyId: user.companyId }, order: { createdAt: 'DESC' } });
    return rows.map((k) => ({ id: k.id, name: k.name, scope: k.scope, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt }));
  }

  async createKey(user: AuthUser, name: string, scope: string = API_SCOPE) {
    this.admin(user);
    if (!(API_SCOPES as readonly string[]).includes(scope)) throw new BadRequestException('不认识的密钥用途');
    const n = name.trim();
    if (!n || n.length > 100) throw new BadRequestException('请输入不超过 100 字的用途名称');
    const id = crypto.randomUUID();
    const key = `kdoa1.${id}.${crypto.randomBytes(32).toString('base64url')}`;
    await this.dataSource.manager.insert(FinanceApiKey, { id, companyId: user.companyId, name: n, scope, keyHash: sha(key), createdBy: user.id });
    return { id, name: n, scope, key, message: '密钥只显示这一次，请立即安全保存。' };
  }

  async revokeKey(user: AuthUser, id: string) {
    this.admin(user);
    const r = await this.dataSource.manager.update(FinanceApiKey, { id, companyId: user.companyId, revokedAt: IsNull() }, { revokedAt: new Date(), revokedBy: user.id });
    if (!r.affected) throw new NotFoundException('密钥不存在或已撤销');
    return { ok: true };
  }

  /** 外部程序用 X-API-Key 读已验证组合；密钥只存哈希，常数时间比较 */
  async authenticateKey(raw: string | undefined, scope: string = API_SCOPE): Promise<number> {
    const m = KEY_RE.exec(raw ?? '');
    if (!m) throw new UnauthorizedException('请提供有效的 X-API-Key。');
    const row = await this.dataSource.manager.findOne(FinanceApiKey, { where: { id: m[1], scope } });
    const expected = Buffer.from(row?.keyHash ?? '0'.repeat(64), 'hex'), actual = Buffer.from(sha(raw as string), 'hex');
    if (!row || row.revokedAt || expected.length !== actual.length || !crypto.timingSafeEqual(actual, expected)) throw new UnauthorizedException('API 密钥无效或已撤销。');
    await this.dataSource.manager.update(FinanceApiKey, { id: row.id }, { lastUsedAt: new Date() });
    return row.companyId;
  }

  /** 金额一律是整数分（amountUnit: 'cent'）；旧系统的 /api/external/verified-bundles 兼容路径见 LegacyVerifiedFeedController（旧字段名和单位） */
  async externalFeed(companyId: number) { return { amountUnit: 'cent', rows: await this.cost.verifiedFeed(companyId) }; }

  // ---------- 主数据重置 ----------
  private scope(includePlatforms:boolean, capturedTypes?:readonly string[]) {
    // 老快照按当时保存的范围恢复，不能因新增类型扩大清理范围。
    const catalog=capturedTypes?[...RESET_TYPES,{type:'finance-scenarios',label:'销售场景',optional:true}]:RESET_TYPES;
    return catalog.filter(type=>capturedTypes?capturedTypes.includes(type.type):!type.optional||includePlatforms);
  }
  private inResetScope(record:ResourceRecord){return record.type!=='finance-product-units'||record.data.kind!=='archive_type';}
  private confirmText(companyId: number) { return `RESET-COMPANY-${companyId}`; }

  async resetPreview(user: AuthUser, includePlatforms: boolean) {
    this.admin(user);
    const rows = await this.dataSource.query(`SELECT type, COUNT(*) AS n FROM resource_records WHERE company_id = ? AND type IN (${this.scope(includePlatforms).map(() => '?').join(',')}) AND (type<>'finance-product-units' OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data,'$.kind')),'')<>'archive_type') GROUP BY type`, [user.companyId, ...this.scope(includePlatforms).map((t) => t.type)]);
    const m = new Map(rows.map((r: { type: string; n: string }) => [r.type, Number(r.n)]));
    const [{ n: docLines }] = await this.dataSource.query('SELECT COUNT(*) AS n FROM finance_document_lines WHERE company_id = ? AND product_id IS NOT NULL', [user.companyId]);
    const blockedByCostVersions = await this.costReferences(this.dataSource.manager,user.companyId);
    const tables = this.scope(includePlatforms).map((t) => ({ type: t.type, label: t.label, count: (m.get(t.type) as number) ?? 0 }));
    return { includePlatforms, confirmation: this.confirmText(user.companyId), total: tables.reduce((s, t) => s + t.count, 0), tables, blockedByDocuments: Number(docLines), blockedByCostVersions, exclusions: ['客户、供应商、费用档案、仓库、快递价格表、人工成本', '财务单据和账务', '成本版本、锁定成本与成本历史', '聚水潭相关外部数据', '档案类型定义、销售场景', '独立采购价/运费/档案成本历史'] };
  }

  private async guardCostReferences(em: EntityManager, companyId: number) {
    await em.findOne(Company,{where:{id:companyId},lock:{mode:'pessimistic_write'}});
    if(await this.costReferences(em,companyId)) throw new ConflictException('商品资料已被成本版本引用或被生产标准引用，不能整体重置或恢复主数据快照；请先处理成本引用');
  }

  private async costReferences(em:EntityManager,companyId:number) {
    // SKU引用始终保护；没有SKU的全局生产标准也可能引用待清理的商品、基础编码或分类。
    const skus=await em.count(ResourceRecord,{where:{companyId,type:'finance-cost-skus'}});
    const standards=await em.count(ResourceLink,{where:{companyId,sourceType:'finance-cost-production-rates',targetType:In(this.scope(true).map(r=>r.type))}});
    return skus+standards;
  }

  private async capture(em: EntityManager, companyId: number, includePlatforms: boolean, operation: string, label: string, userId: number,capturedTypes?:readonly string[]) {
    const types = this.scope(includePlatforms,capturedTypes).map((t) => t.type);
    const records = (await em.find(ResourceRecord, { where: { companyId, type: In(types) }, order: { id: 'ASC' } })).filter(record=>this.inResetScope(record));
    const ids = records.map((r) => r.id);
    const links = ids.length ? await em.find(ResourceLink, { where: [{ companyId, sourceId: In(ids) }, { companyId, targetId: In(ids) }] }) : [];
    const res = await em.insert(FinanceMasterSnapshot, { companyId, operation, label, scopeJson: { includePlatforms, types }, snapshotJson: JSON.stringify({ records, links }), rowCount: records.length + links.length, createdBy: userId });
    return { id: Number(res.identifiers[0].id), rowCount: records.length + links.length };
  }

  private async clear(em: EntityManager, companyId: number, includePlatforms: boolean,capturedTypes?:readonly string[]) {
    const out: Array<{ type: string; label: string; count: number }> = [];
    for (const t of this.scope(includePlatforms,capturedTypes)) {
      const ids = (await em.find(ResourceRecord, { where: { companyId, type: t.type } })).filter(record=>this.inResetScope(record)).map((r) => r.id);
      if (ids.length) {
        await em.delete(ResourceLink, { companyId, sourceId: In(ids) });
        await em.delete(ResourceLink, { companyId, targetId: In(ids) });
        await em.delete(ResourceRecord, { companyId, id: In(ids) });
      }
      out.push({ type: t.type, label: t.label, count: ids.length });
    }
    return out;
  }

  async resetExecute(user: AuthUser, body: { confirm: string; includePlatforms?: boolean; label?: string }) {
    this.admin(user);
    if (body.confirm !== this.confirmText(user.companyId)) throw new BadRequestException(`确认文本不正确，应为 ${this.confirmText(user.companyId)}`);
    const includePlatforms = body.includePlatforms !== false;
    return this.dataSource.transaction(async (em) => {
      await this.guardCostReferences(em,user.companyId);
      await em.query("INSERT IGNORE INTO finance_doc_counters (company_id, counter_key, value) VALUES (?, 'lock:posting', 0)", [user.companyId]);
      await em.query("SELECT value FROM finance_doc_counters WHERE company_id = ? AND counter_key = 'lock:posting' FOR UPDATE", [user.companyId]);
      const [{ n }] = await em.query('SELECT COUNT(*) AS n FROM finance_document_lines WHERE company_id = ? AND product_id IS NOT NULL', [user.companyId]);
      if (Number(n) > 0) throw new ConflictException(`已有 ${n} 行财务单据明细用到了商品档案，重置会让这些单据找不到商品。请先处理单据，或联系管理员单独清理`);
      const snapshot = await this.capture(em, user.companyId, includePlatforms, 'reset', body.label?.trim() || '商品基础资料清空前快照', user.id);
      const deleted = await this.clear(em, user.companyId, includePlatforms);
      await em.insert(ResourceChangeLog, { companyId: user.companyId, resourceType: 'finance-products', resourceId: 0, action: 'master-reset', actorId: user.id, beforeJson: null, afterJson: null, note: `主数据整体重置，快照 #${snapshot.id}` });
      return { ok: true, snapshot, deleted, totalDeleted: deleted.reduce((s, d) => s + d.count, 0) };
    });
  }

  async snapshots(user: AuthUser) {
    this.admin(user);
    const rows = await this.dataSource.query('SELECT s.id, s.operation, s.label, s.scope_json AS scopeJson, s.row_count AS rowCount, s.restored_at AS restoredAt, s.created_at AS createdAt, u.name AS actorName FROM finance_master_snapshots s LEFT JOIN users u ON u.id = s.created_by AND u.company_id = s.company_id WHERE s.company_id = ? ORDER BY s.id DESC LIMIT 50', [user.companyId]);
    return rows.map((r: Record<string, unknown>) => ({ ...r, confirmation: `RESTORE-SNAPSHOT-${r.id}` }));
  }

  async restore(user: AuthUser, id: number, confirm: string) {
    this.admin(user);
    if (confirm !== `RESTORE-SNAPSHOT-${id}`) throw new BadRequestException(`确认文本不正确，应为 RESTORE-SNAPSHOT-${id}`);
    return this.dataSource.transaction(async (em) => {
      await this.guardCostReferences(em,user.companyId);
      await em.query("INSERT IGNORE INTO finance_doc_counters (company_id, counter_key, value) VALUES (?, 'lock:posting', 0)", [user.companyId]);
      await em.query("SELECT value FROM finance_doc_counters WHERE company_id = ? AND counter_key = 'lock:posting' FOR UPDATE", [user.companyId]);
      const snap = await em.findOne(FinanceMasterSnapshot, { where: { id, companyId: user.companyId } });
      if (!snap) throw new NotFoundException('备份快照不存在');
      const scope = snap.scopeJson as { includePlatforms?: boolean;types?:string[] };
      const includePlatforms = scope.includePlatforms !== false;
      const safety = await this.capture(em, user.companyId, includePlatforms, 'pre_restore', `恢复快照 #${id} 前的安全快照`, user.id,scope.types);
      await this.clear(em, user.companyId, includePlatforms,scope.types);
      const data = JSON.parse(snap.snapshotJson) as { records: Array<Record<string, unknown>>; links: Array<Record<string, unknown>> };
      const date = (v: unknown) => (typeof v === 'string' ? new Date(v) : v);
      for (const r of data.records) await em.insert(ResourceRecord, { ...r, createdAt: date(r.createdAt) } as never);
      for (const l of data.links) await em.insert(ResourceLink, { ...l, createdAt: date(l.createdAt) } as never);
      await em.update(FinanceMasterSnapshot, { id }, { restoredAt: new Date() });
      return { ok: true, snapshotId: id, safetySnapshot: safety, restored: data.records.length + data.links.length };
    });
  }
}
