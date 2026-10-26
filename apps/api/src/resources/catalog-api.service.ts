import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { CostService } from './cost.service';

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface CatalogQuery { afterId?: number; limit?: number; code?: string }

/**
 * 给持有 company_catalog_read 密钥的外部程序读的商品与成本目录（只读）。
 * 一律 id 升序、afterId 翻页、每页 1～100 条；只给已验证的组合，金额都是分。
 */
@Injectable()
export class CatalogApiService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly cost: CostService) {}

  private page<T extends { id: number }>(companyId: number, all: T[], q: CatalogQuery) {
    const limit = Math.min(100, Math.max(1, q.limit ?? 50));
    const sorted = all.filter((x) => x.id > (q.afterId ?? 0)).sort((a, b) => a.id - b.id);
    const items = sorted.slice(0, limit);
    return { apiVersion: '1', companyId, generatedAt: new Date().toISOString(), items, hasMore: sorted.length > limit, nextAfterId: items.length ? items[items.length - 1].id : q.afterId ?? 0 };
  }

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
    return this.page(companyId, [...keep].map((id) => ({ id, name: byId.get(id)!.title, code: str(byId.get(id)!.data.code), parentId: num(byId.get(id)!.data.parentId), bundleCount: count(id) })), q);
  }

  async costCategories(companyId: number, q: CatalogQuery) {
    const d = await this.cost.load(companyId);
    const { rows } = await this.cost.allRows(this.sys(companyId));
    const tree = this.cost.categoryTree(d, rows.filter((r) => r.status === 'verified'));
    return this.page(companyId, tree.categories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, marginPercent: c.percent, marginSource: c.source, bundleCount: c.count })), q);
  }

  async skuCosts(companyId: number, q: CatalogQuery) {
    const rows = await this.verifiedRows(companyId);
    return this.page(companyId, rows.filter((r) => !q.code || r.code === q.code).map((r) => ({
      id: r.bundleId, code: r.code, name: r.name, categoryId: r.categoryId, categoryName: r.categoryName, weightG: r.weightG, preShipCostCents: r.preShipCostCents,
      freightCents: r.freightCents, costIncludingFreightCents: r.costIncludingFreightCents, marginPercent: r.marginPercent, minPriceCents: r.minPriceCents,
    })), q);
  }

  async bundleCodes(companyId: number, q: CatalogQuery) {
    const rows = await this.verifiedRows(companyId);
    const meta = new Map((await this.ds.manager.find(ResourceRecord, { where: { companyId, type: 'finance-bundles', status: 'verified' } })).map((b) => [b.id, b]));
    return this.page(companyId, rows.filter((r) => !q.code || r.code === q.code).map((r) => {
      const b = meta.get(r.bundleId);
      return { id: r.bundleId, code: r.code, name: r.name, styleCode: str(b?.data.styleCode), shortName: str(b?.data.shortName), platformCode: str(b?.data.platformCode), categoryId: r.categoryId, categoryName: r.categoryName, weightG: r.weightG };
    }), q);
  }
}
