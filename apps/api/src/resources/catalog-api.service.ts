import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { CostService } from './cost.service';
import { sigOf } from './base-code-support';

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface CatalogQuery { afterId?: number; limit?: number; code?: string }

/**
 * 给持有 company_catalog_read 密钥的外部程序读的商品与成本目录（只读）。
 * 一律 id 升序、afterId 翻页、每页 1～100 条；只给已验证的组合。
 *
 * 金额单位：新字段（*Cents）一律是整数分，响应里 amountUnit = 'cent'。
 * 旧系统（Node 版 /api/external/catalog/v1）的金额是元、利润率是 0～1 的小数、重量是千克：为了不让已经对接的外部程序改代码，
 * 旧字段名原样保留（rows、nextCursor、total、skuCode、productCost、minimumSellingPrice、profitRate、weighingWeight 等），
 * 数值仍按旧单位（元/小数/千克）给；新旧字段同时存在，新对接请用 *Cents。
 */
@Injectable()
export class CatalogApiService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly cost: CostService) {}

  private page<T extends { id: number }>(companyId: number, all: T[], q: CatalogQuery) {
    const limit = Math.min(100, Math.max(1, q.limit ?? 50));
    const sorted = all.filter((x) => x.id > (q.afterId ?? 0)).sort((a, b) => a.id - b.id);
    const items = sorted.slice(0, limit);
    const hasMore = sorted.length > limit;
    const nextAfterId = items.length ? items[items.length - 1].id : q.afterId ?? 0;
    // rows / nextCursor / total 是旧接口的字段名（旧：没有下一页 nextCursor = null）
    return { apiVersion: '1', amountUnit: 'cent', companyId, generatedAt: new Date().toISOString(), items, hasMore, nextAfterId, rows: items, nextCursor: hasMore ? nextAfterId : null, total: all.length };
  }

  /** 旧接口的金额是元（分 / 100），没有值保持 null */
  private yuan = (c: number | null) => (c === null ? null : c / 100);

  private sys(companyId: number): AuthUser {
    return { id: 0, companyId, name: '对外接口', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  }

  private async verifiedRows(companyId: number) {
    const { rows } = await this.cost.allRows(this.sys(companyId));
    return rows.filter((r) => r.status === 'verified');
  }

  async bundleCategories(companyId: number, q: CatalogQuery) {
    const rows = await this.verifiedRows(companyId);
    const used = new Set(rows.map((r) => r.categoryId).filter((x): x is number => !!x));
    const cats = await this.ds.manager.find(ResourceRecord, { where: { companyId, type: 'finance-categories' } });
    const byId = new Map(cats.map((c) => [c.id, c]));
    const keep = new Set<number>();
    for (const id of used) for (let cur: number | null = id, i = 0; cur && i < 8 && !keep.has(cur); i++, cur = num(byId.get(cur)?.data.parentId)) keep.add(cur);
    const count = (id: number) => rows.filter((r) => { for (let cur: number | null = r.categoryId, i = 0; cur && i < 8; i++, cur = num(byId.get(cur)?.data.parentId)) if (cur === id) return true; return false; }).length;
    const flat = [...keep].map((id) => {
      const chain: number[] = [];
      for (let cur: number | null = id, i = 0; cur && i < 8 && !chain.includes(cur); i++, cur = num(byId.get(cur)?.data.parentId)) chain.unshift(cur);
      const c = byId.get(id)!;
      return { id, name: c.title, code: str(c.data.code), parentId: num(c.data.parentId), bundleCount: count(id), status: c.status === 'active' ? 'active' : 'inactive', sortOrder: Number(c.data.sort) || 0, pathIds: chain, pathNames: chain.map((x) => byId.get(x)?.title ?? '') };
    });
    return { ...this.page(companyId, flat, q), tree: this.tree(flat) };
  }

  /** 旧接口的分类树（children 嵌套） */
  private tree<T extends { id: number; parentId: number | null; sortOrder: number }>(flat: T[]): Array<T & { children: unknown[] }> {
    const nodes = new Map(flat.map((r) => [r.id, { ...r, children: [] as unknown[] }]));
    const top: Array<T & { children: unknown[] }> = [];
    for (const n of nodes.values()) { const p = n.parentId ? nodes.get(n.parentId) : undefined; if (p) p.children.push(n); else top.push(n); }
    const sort = (xs: Array<{ sortOrder: number; id: number; children: unknown[] }>) => { xs.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id); xs.forEach((x) => sort(x.children as never)); };
    sort(top as never);
    return top;
  }

  async costCategories(companyId: number, q: CatalogQuery) {
    const d = await this.cost.load(companyId);
    const { rows } = await this.cost.allRows(this.sys(companyId));
    const tree = this.cost.categoryTree(d, rows.filter((r) => r.status === 'verified'));
    const frac = (p: number | null) => (p === null ? null : p / 100);
    const page = this.page(companyId, tree.categories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, marginPercent: c.percent, marginSource: c.source, bundleCount: c.count, profitRate: frac(c.percent), ownRate: frac(c.ownPercent), status: 'active' })), q);
    return { ...page, defaultMargin: { profitRate: frac(tree.defaultMargin.percent), marginPercent: tree.defaultMargin.percent } };
  }

  async skuCosts(companyId: number, q: CatalogQuery) {
    const rows = await this.verifiedRows(companyId);
    return this.page(companyId, rows.filter((r) => !q.code || r.code === q.code).map((r) => ({
      id: r.bundleId, code: r.code, name: r.name, categoryId: r.categoryId, categoryName: r.categoryName, weightG: r.weightG, preShipCostCents: r.preShipCostCents,
      freightCents: r.freightCents, costIncludingFreightCents: r.costIncludingFreightCents, marginPercent: r.marginPercent, minPriceCents: r.minPriceCents,
      // 旧字段名（元 / 0～1 小数 / 千克）
      bundleCodeId: r.bundleId, skuCode: r.code, skuName: r.name, productCost: this.yuan(r.preShipCostCents), preShipCost: this.yuan(r.preShipCostCents), carrierName: r.carrierName,
      freight: this.yuan(r.freightCents), effectiveFreight: this.yuan(r.freightCents), costIncludingFreight: this.yuan(r.costIncludingFreightCents),
      profitRate: r.marginPercent === null ? null : r.marginPercent / 100, minimumSellingPrice: this.yuan(r.minPriceCents), weighingWeight: r.weightG === null ? null : r.weightG / 1000,
      freightSource: r.freightMethod ?? '缺少运费预估',
    })), q);
  }

  async bundleCodes(companyId: number, q: CatalogQuery) {
    const rows = await this.verifiedRows(companyId);
    const meta = new Map((await this.ds.manager.find(ResourceRecord, { where: { companyId, type: 'finance-bundles', status: 'verified' } })).map((b) => [b.id, b]));
    const comps = await this.components(companyId);
    return this.page(companyId, rows.filter((r) => !q.code || r.code === q.code).map((r) => {
      const b = meta.get(r.bundleId);
      return {
        id: r.bundleId, code: r.code, name: r.name, styleCode: str(b?.data.styleCode), shortName: str(b?.data.shortName), platformCode: str(b?.data.platformCode), categoryId: r.categoryId, categoryName: r.categoryName, weightG: r.weightG,
        // 旧接口字段：验证状态、问题清单、资料快照和组成
        status: 'active', verificationStatus: 'verified', verifiedAt: str(b?.data.verifiedAt) || null, issues: [],
        profile: this.profile(b, r), components: comps.get(r.bundleId) ?? [],
      };
    }), q);
  }

  /** 旧接口 profile 的兼容子集（旧系统的验证快照字段名） */
  private profile(b: ResourceRecord | undefined, r: { code: string; name: string; categoryId: number | null; weightG: number | null }) {
    return {
      final_code: r.code, final_style_code: str(b?.data.styleCode), product_name: r.name, short_name: str(b?.data.shortName), properties_value: str(b?.data.propertiesValue),
      base_unit: str(b?.data.baseUnit), category_dictionary_id: r.categoryId, weighing_weight: r.weightG === null ? null : r.weightG / 1000, status: 'active',
    };
  }

  /** 每个组合的组成（旧接口 components 的兼容子集） */
  private async components(companyId: number) {
    const lines = await this.ds.manager.find(ResourceRecord, { where: { companyId, type: 'finance-bundle-lines' } });
    const bcs = new Map((await this.ds.manager.find(ResourceRecord, { where: { companyId, type: 'finance-base-codes' } })).map((b) => [b.id, b]));
    const out = new Map<number, Array<Record<string, unknown>>>();
    for (const l of lines.sort((a, b) => (num(a.data.sortOrder) ?? 0) - (num(b.data.sortOrder) ?? 0) || a.id - b.id)) {
      const bid = num(l.data.bundleId);
      if (!bid) continue;
      const bc = bcs.get(num(l.data.baseCodeId) ?? -1);
      (out.get(bid) ?? out.set(bid, []).get(bid)!).push({ role: str(l.data.role), componentType: str(l.data.role) === 'labor' ? 'labor' : 'base_code', componentCode: bc ? str(bc.data.code) : null, componentName: bc ? str(bc.data.name) || bc.title : null, quantity: num(l.data.qty), unitName: str(l.data.unit) || null, includeInJstBundle: l.data.includeInJst !== false });
    }
    return out;
  }

  // ---------- 旧 /verified-feed 的兼容读取：旧字段名和形状（外部程序不用改代码）----------

  private async legacyRecords(companyId: number) {
    const rows = await this.verifiedRows(companyId);
    const meta = new Map((await this.ds.manager.find(ResourceRecord, { where: { companyId, type: 'finance-bundles', status: 'verified' } })).map((b) => [b.id, b]));
    const comps = await this.components(companyId);
    const cats = await this.ds.manager.find(ResourceRecord, { where: { companyId, type: 'finance-categories' } });
    const byCat = new Map(cats.map((c) => [c.id, c]));
    const counts: Array<{ bundle_id: number; n: string }> = await this.ds.query("SELECT bundle_id, COUNT(*) AS n FROM finance_cost_snapshots WHERE company_id = ? AND event_type = 'workflow_publish' GROUP BY bundle_id", [companyId]);
    const countById = new Map(counts.map((c) => [Number(c.bundle_id), Number(c.n)]));
    return rows.sort((a, b) => a.bundleId - b.bundleId).map((r) => {
      const b = meta.get(r.bundleId);
      const components = comps.get(r.bundleId) ?? [];
      const chain: number[] = [];
      for (let cur: number | null = r.categoryId, i = 0; cur && i < 8 && !chain.includes(cur); i++, cur = num(byCat.get(cur)?.data.parentId)) chain.unshift(cur);
      const c = r.categoryId ? byCat.get(r.categoryId) : undefined;
      const mains = components.filter((x) => x.role === 'main').map((x) => ({ code: x.componentCode, name: x.componentName, quantity: x.quantity, unit: x.unitName }));
      return {
        id: r.bundleId, code: r.code, name: r.name, categoryId: r.categoryId,
        category: c ? { id: c.id, code: str(c.data.code), name: c.title, parentId: num(c.data.parentId), pathIds: chain, pathNames: chain.map((x) => byCat.get(x)?.title ?? '') } : null,
        mainProductName: mains.map((m) => m.name).filter(Boolean).join('+'), mainProducts: mains,
        verification: { status: 'verified', count: Math.max(1, countById.get(r.bundleId) ?? 1), verifiedAt: str(b?.data.verifiedAt) || null, signature: sigOf(str(b?.data.snapshot)) },
        details: { profile: this.profile(b, r), components },
      };
    });
  }

  /** 旧：GET /verified-feed?afterId=&limit= → { rows, nextCursor, total } */
  async legacyFeed(companyId: number, q: { afterId?: number; limit?: number }) {
    const all = await this.legacyRecords(companyId);
    const limit = Math.min(100, Math.max(1, q.limit ?? 100));
    const remaining = all.filter((r) => r.id > (q.afterId ?? 0));
    const page = remaining.slice(0, limit);
    return { rows: page, nextCursor: remaining.length > limit ? page[page.length - 1].id : null, total: all.length };
  }

  async legacyAll(companyId: number) {
    const all = await this.legacyRecords(companyId);
    return { rows: all, nextCursor: null, total: all.length };
  }

  async legacyByCode(companyId: number, code: string) {
    return (await this.legacyRecords(companyId)).find((r) => r.code === code) ?? null;
  }

  /** 旧：GET /verified-feed/categories → { rows, tree, total }（旧系统是整个组合分类字典，不只是用到的） */
  async legacyCategories(companyId: number) {
    const cats = (await this.ds.manager.find(ResourceRecord, { where: { companyId, type: 'finance-categories' } })).filter((c) => c.data.archiveType === 'bundle');
    const byId = new Map(cats.map((c) => [c.id, c]));
    const flat = cats.map((c) => {
      const chain: number[] = [];
      for (let cur: number | null = c.id, i = 0; cur && i < 8 && !chain.includes(cur); i++, cur = num(byId.get(cur)?.data.parentId)) chain.unshift(cur);
      return { id: c.id, code: str(c.data.code), name: c.title, parentId: num(c.data.parentId), status: c.status === 'active' ? 'active' : 'inactive', sortOrder: Number(c.data.sort) || 0, pathIds: chain, pathNames: chain.map((x) => byId.get(x)?.title ?? '') };
    }).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    return { rows: flat, tree: this.tree(flat), total: flat.length };
  }
}
