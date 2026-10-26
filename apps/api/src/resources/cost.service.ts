import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  PROVINCES, todayInChina, minSalePriceCentsByMicroPercent, percentToMicro, resolveMargin, createChecker, buildEstimateRows, buildAutomaticRecommendations, groupAutomaticRecommendations, sortRecommendationRules,
  freightFromEstimateRows, validParcelLimit, type EstimateRow,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { buildPriceGroups, DEFAULT_PARCEL_LIMIT } from './express.service';

type Data = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const TYPES = ['finance-bundles', 'finance-bundle-lines', 'finance-base-codes', 'finance-products', 'finance-labor-costs', 'finance-margins', 'finance-categories', 'finance-express-prices', 'finance-freight-overrides', 'finance-express-carriers', 'finance-express-branches', 'finance-express-versions', 'finance-freight-estimates'];
const EXPRESS_TYPES = ['finance-express-carriers', 'finance-express-branches', 'finance-express-versions', 'finance-express-prices'];

export interface CostLine { role: string; code: string; name: string; qty: number; unitCostCents: number | null; subtotalCents: number | null; unitWeightG: number | null; weightG: number }
export interface CostRow {
  bundleId: number; code: string; name: string; status: string; categoryId: number | null; categoryName: string;
  preShipCostCents: number | null; weightG: number | null;
  freightCents: number | null; freightMethod: string | null;
  marginPercent: number | null; marginSource: string;
  /** 本组合自己设了利润率（覆盖分类和默认） */
  marginOverride: boolean;
  /** 不算本组合覆盖时，从分类一路继承到的利润率 */
  inheritedMargin: { percent: number | null; source: string };
  /** 使用快递（备注，不参与运费预估） */
  carrierName: string;
  /** 含快递成本 = 发货前成本 + 运费；运费还没估出来时为 null */
  costIncludingFreightCents: number | null;
  /** 乐观锁令牌：保存售价设置时原样带回，别人先改过就拒绝 */
  revision: string;
  minPriceCents: number | null; issues: string[]; lines: CostLine[];
  /** 排序用：组合最近修改时间 */
  updatedAtMs: number;
}
export interface CategoryNode {
  id: number; name: string; parentId: number | null;
  /** 这个分类自己设的利润率；没设为 null（继承） */
  ownPercent: number | null; percent: number | null; source: string; revision: string;
  /** 本分类及所有下级分类下的组合数 */
  count: number;
}
export type CostData = Awaited<ReturnType<CostService['load']>>;

const sha = (v: unknown) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);
/** 售价设置的乐观锁令牌：随这些字段内容而变，所以从资料页直接改也能被发现 */
export const bundleRevision = (b: Pick<ResourceRecord, 'status' | 'data'>) =>
  sha([b.status, b.data.carrierName ?? null, b.data.marginOverridePercent ?? null, b.data.manualFreight ?? null, b.data.weightMode ?? null, b.data.manualWeightG ?? null]);
export const marginRevision = (m: Pick<ResourceRecord, 'data'> | undefined) => (m && num(m.data.profitPercent) !== null ? sha(['m', m.data.profitPercent]) : 'none');

/** 成本表：每次现算，不存副本——商品成本、重量、利润率、运费任何一处变了，这里立刻跟着变。 */
@Injectable()
export class CostService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async load(companyId: number, em: EntityManager = this.dataSource.manager) {
    const rows = await em.find(ResourceRecord, { where: { companyId, type: In(TYPES) } });
    const by = (t: string) => rows.filter((r) => r.type === t);
    const map = (t: string) => new Map(by(t).map((r) => [r.id, r]));
    // 运费和“预估运费一览”页用同一套引擎：合作中的当前版本（含版本的可发货重量范围）→ 按重量段取各省最低价 → 手工金额（拆包时也沿用）
    const groups = buildPriceGroups(rows.filter((r) => EXPRESS_TYPES.includes(r.type)), todayInChina());
    const snap = rows.find((r) => r.type === 'finance-freight-estimates' && r.uniqueKey === 'default');
    const limit = snap ? num(snap.data.parcelLimit) : null;
    const parcelLimit = validParcelLimit(limit) ? limit : DEFAULT_PARCEL_LIMIT;
    const estimateRows: EstimateRow[] = buildEstimateRows(groups, PROVINCES, parcelLimit);
    for (const o of by('finance-freight-overrides').filter((r) => r.status === 'active')) {
      const from = num(o.data.weightFrom), to = num(o.data.weightTo), amount = num(o.data.amount);
      const row = estimateRows.find((r) => r.start === from && r.end === to);
      if (row && amount !== null) row.manualAmount = amount;
    }
    return {
      bundles: by('finance-bundles'), lines: by('finance-bundle-lines'), baseCodes: map('finance-base-codes'), products: map('finance-products'),
      labor: map('finance-labor-costs'), margins: by('finance-margins'), categories: map('finance-categories'),
      groups, freight: { rows: estimateRows, parcelLimit },
    };
  }

  /** 总重量（kg）的运费（分）：没有合适价格返回 null */
  freightFor(d: CostData, weightKg: number) {
    const hit = freightFromEstimateRows(d.freight.rows, weightKg, d.freight.parcelLimit);
    if (!hit) return null;
    const row = weightKg <= d.freight.parcelLimit ? d.freight.rows.find((r) => weightKg > r.start && weightKg <= r.end) : undefined;
    return { cents: hit.amount, method: hit.method as string, samples: row?.sampleCount ?? 0 };
  }

  async freightEstimate(user: AuthUser, weightG: number) {
    if (!(weightG > 0)) throw new BadRequestException('重量必须大于 0');
    const d = await this.load(user.companyId);
    return { weightG, ...(this.freightFor(d, weightG / 1000) ?? { cents: null, method: null, samples: 0 }) };
  }

  /** 分类自己 → 逐级上级 → 全部默认，取第一个设过的利润率 */
  marginFor(d: CostData, categoryId: number | null): { percent: number | null; source: string } {
    const byScope = new Map(d.margins.map((m) => [str(m.data.scopeKey), num(m.data.profitPercent)]));
    const chain: Array<{ v: number | null | undefined; s: string }> = [];
    let cur = categoryId, guard = 0;
    while (cur && guard++ < 6) {
      const c = d.categories.get(cur);
      chain.push({ v: byScope.get(`cat:${cur}`), s: chain.length === 0 ? '本分类' : `上级分类「${c?.title ?? cur}」` });
      cur = c ? num(c.data.parentId) : null;
    }
    chain.push({ v: byScope.get('all'), s: '全部默认' });
    const hit = chain.find((x) => x.v !== null && x.v !== undefined);
    return { percent: resolveMargin(chain.map((x) => x.v)), source: hit?.s ?? '未设置' };
  }

  row(d: CostData, b: ResourceRecord): CostRow {
    const issues: string[] = [];
    const lines: CostLine[] = [];
    let cost: number | null = 0, weight = 0, categoryId: number | null = null;
    for (const l of d.lines.filter((x) => num(x.data.bundleId) === b.id).sort((x, y) => x.id - y.id)) {
      const qty = num(l.data.qty) ?? 0, role = str(l.data.role);
      let unit: number | null = null, w = 0, code = '', name = '';
      let hasWeight = false;
      if (role === 'labor') {
        const lab = d.labor.get(num(l.data.laborId) ?? -1);
        unit = lab ? num(lab.data.unitPrice) : null;
        name = lab?.title ?? '人工';
        code = '人工';
      } else {
        const bc = d.baseCodes.get(num(l.data.baseCodeId) ?? -1);
        const p = bc ? d.products.get(num(bc.data.productId) ?? -1) : undefined;
        unit = p ? num(p.data.totalCost) : null;
        w = p ? (num(p.data.weightG) ?? 0) : 0;
        hasWeight = true;
        code = str(bc?.data.code);
        name = str(bc?.data.name) || bc?.title || '';
        if (role === 'main' && categoryId === null && bc) categoryId = num(bc.data.categoryId);
      }
      const sub = unit === null ? null : Math.round(unit * qty);
      if (sub === null) { issues.push(`「${name || code}」还没有成本`); cost = null; } else if (cost !== null) cost += sub;
      weight += w * qty;
      lines.push({ role, code, name, qty, unitCostCents: unit, subtotalCents: sub, unitWeightG: hasWeight ? w : null, weightG: Math.round(w * qty * 100) / 100 });
    }
    if (lines.length === 0) { cost = null; issues.push('还没有构成'); }
    let weightG: number | null = Math.round(weight * 100) / 100;
    if (str(b.data.weightMode) === 'manual') weightG = num(b.data.manualWeightG);
    if (!weightG) { weightG = null; issues.push('没有重量'); }

    let freight: number | null = null, method: string | null = null;
    const manual = num(b.data.manualFreight);
    if (manual !== null) { freight = manual; method = '手工填写'; } else if (weightG) {
      const est = this.freightFor(d, weightG / 1000);
      if (est) { freight = est.cents; method = est.method; } else issues.push('运费无法预估（这个重量段报价不足 3 个省，或超出可发货重量）');
    }
    const own = num(b.data.marginOverridePercent);
    const inherited = this.marginFor(d, categoryId);
    const m = own !== null ? { percent: own, source: '本组合覆盖' } : inherited;
    if (m.percent === null) issues.push('没有设置利润率');
    // 利润率按百分数 6 位小数的全部精度参与计算（不能先取整到万分比），向上取整到分
    const micro = percentToMicro(m.percent);
    if (m.percent !== null && micro === null) issues.push('利润率不合法（要在 0 到 100% 之间，不含 100，最多 6 位小数）');
    const freightForPrice = cost === null ? null : freight;
    const min = minSalePriceCentsByMicroPercent({ preShipCostCents: cost ?? 0, freightCents: freightForPrice, marginMicroPercent: micro });
    return {
      bundleId: b.id, code: str(b.data.code), name: str(b.data.name), status: b.status, categoryId, categoryName: categoryId ? (d.categories.get(categoryId)?.title ?? '') : '',
      preShipCostCents: cost, weightG, freightCents: freight, freightMethod: method, marginPercent: m.percent, marginSource: m.source,
      marginOverride: own !== null, inheritedMargin: inherited, carrierName: str(b.data.carrierName),
      costIncludingFreightCents: cost === null || freight === null ? null : cost + freight,
      revision: bundleRevision(b),
      minPriceCents: min, issues, lines, updatedAtMs: b.updatedAt ? new Date(b.updatedAt).getTime() : 0,
    };
  }

  /** 分类目录：每个分类的组合数（含下级）、自己设的利润率、继承到的利润率和乐观锁令牌 */
  categoryTree(d: CostData, rows: CostRow[]): { categories: CategoryNode[]; defaultMargin: { percent: number | null; revision: string }; allTotal: number } {
    const direct = new Map<number, number>();
    for (const r of rows) if (r.categoryId) direct.set(r.categoryId, (direct.get(r.categoryId) ?? 0) + 1);
    const children = new Map<number, number[]>();
    for (const c of d.categories.values()) {
      const pid = num(c.data.parentId);
      if (pid) children.set(pid, [...(children.get(pid) ?? []), c.id]);
    }
    const total = (id: number, seen = new Set<number>()): number => {
      if (seen.has(id)) return 0;
      seen.add(id);
      return (direct.get(id) ?? 0) + (children.get(id) ?? []).reduce((sum, k) => sum + total(k, seen), 0);
    };
    const mine = new Map(d.margins.map((m) => [str(m.data.scopeKey), m]));
    const categories: CategoryNode[] = [];
    for (const c of d.categories.values()) {
      if (c.status !== 'active') continue;
      const own = mine.get(`cat:${c.id}`);
      const ownPercent = own ? num(own.data.profitPercent) : null;
      const count = total(c.id);
      if (count === 0 && ownPercent === null) continue;
      const eff = this.marginFor(d, c.id);
      categories.push({ id: c.id, name: c.title, parentId: num(c.data.parentId), ownPercent, percent: eff.percent, source: eff.source, revision: marginRevision(own), count });
    }
    const keep = new Set(categories.map((c) => c.id));
    // 上级不在目录里的，挂到最上层，避免树断开
    for (const c of categories) if (c.parentId && !keep.has(c.parentId)) c.parentId = null;
    categories.sort((a, b) => (num(d.categories.get(a.id)?.data.sort) ?? 0) - (num(d.categories.get(b.id)?.data.sort) ?? 0) || a.id - b.id);
    const all = mine.get('all');
    return { categories, defaultMargin: { percent: all ? num(all.data.profitPercent) : null, revision: marginRevision(all) }, allTotal: rows.length };
  }

  /** 全部未归档组合的成本行（已现算） */
  async allRows(user: AuthUser, em?: EntityManager) {
    const d = await this.load(user.companyId, em);
    return { d, rows: d.bundles.filter((b) => b.status !== 'archived').map((b) => this.row(d, b)) };
  }

  async table(user: AuthUser, q: { categoryId?: number; keyword?: string; page: number; pageSize: number }) {
    const { d, rows: every } = await this.allRows(user);
    const kw = (q.keyword ?? '').trim().toLowerCase();
    // 分类筛选包含下级
    const inCat = (cid: number | null) => {
      if (!q.categoryId) return true;
      let cur = cid, guard = 0;
      while (cur && guard++ < 6) { if (cur === q.categoryId) return true; cur = num(d.categories.get(cur)?.data.parentId); }
      return false;
    };
    const all = every.filter((r) => !kw || `${r.code} ${r.name}`.toLowerCase().includes(kw)).filter((r) => inCat(r.categoryId))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.bundleId - a.bundleId);
    const start = (q.page - 1) * q.pageSize;
    const tree = this.categoryTree(d, every);
    return {
      total: all.length, page: q.page, pageSize: q.pageSize, rows: all.slice(start, start + q.pageSize),
      ...tree, canEdit: createChecker(user.permissions)('product.cost.edit'),
    };
  }

  /** 快递分区建议：按当天生效的价格表现算，不自动写入聚水潭 */
  async zoneSuggestion(user: AuthUser, maxWeightKg: number) {
    if (!(maxWeightKg > 0) || maxWeightKg > 1000) throw new BadRequestException('最高重量要大于 0 且不超过 1000kg');
    const d = await this.load(user.companyId);
    const raw = buildAutomaticRecommendations(d.groups, PROVINCES, maxWeightKg);
    const rules = sortRecommendationRules(groupAutomaticRecommendations(raw));
    // 只列固定标准运费的建议（首重续重的报价没有单一金额）
    const rows = rules.flatMap((r) => (r.amount === null ? [] : [{
      carrier: r.carrierName, branch: r.branchName, weightStart: r.weightStart, weightEnd: r.weightEnd === '' ? maxWeightKg : r.weightEnd,
      cents: r.amount, provinces: r.provinces, suggestedName: r.suggestedRuleName,
    }]));
    return { generatedAt: new Date().toISOString(), day: todayInChina(), maxWeightKg, ruleCount: d.groups.reduce((n, g) => n + g.rules.length, 0), rows };
  }

  /** 对外只读：已验证的组合及成本、运费、最低售价（给持有 API 密钥的外部程序） */
  async verifiedFeed(companyId: number) {
    const d = await this.load(companyId);
    return d.bundles.filter((b) => b.status === 'verified').map((b) => this.row(d, b))
      .map((r) => ({ bundleId: r.bundleId, code: r.code, name: r.name, categoryName: r.categoryName, weightG: r.weightG, preShipCostCents: r.preShipCostCents, freightCents: r.freightCents, marginPercent: r.marginPercent, minPriceCents: r.minPriceCents }));
  }

  async one(user: AuthUser, bundleId: number, em?: EntityManager) {
    const d = await this.load(user.companyId, em);
    const b = d.bundles.find((x) => x.id === bundleId);
    if (!b) throw new NotFoundException('组合不存在');
    return this.row(d, b);
  }
}
