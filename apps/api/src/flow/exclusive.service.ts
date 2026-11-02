import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { FlowRun, ResourceRecord } from '../entities';
import { ResourcesService } from '../resources/resources.service';
import { EXCLUSIVE_TEMPLATE, EXCLUSIVE_TYPE, familyMembers } from '../resources/product-exclusive';

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const PAGE_CAP = 100;

/**
 * 专属品领取页的辅助接口（旧系统 ExclusiveProductApplication）：可选商品清单（带“可领取/某某专属/某某申请中”）、专属记录与历史、取消专属。
 * 申请与审批本身走统一流程（模板 product-exclusive）；这里不决定谁审批。
 */
@Injectable()
export class ExclusiveService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly resources: ResourcesService) {}

  /** 基础商品清单。别名（马甲）不单列，随本体；停用/归档的不列。每条标注这一族现在能不能领。 */
  async options(user: AuthUser, q: { keyword?: string; categoryId?: number; onlyFree?: boolean }) {
    const em = this.ds.manager;
    const c = user.companyId;
    const [codes, products, cats, grants, runs, members] = await Promise.all([
      em.find(ResourceRecord, { where: { companyId: c, type: 'finance-base-codes' } }),
      em.find(ResourceRecord, { where: { companyId: c, type: 'finance-products' }, select: ['id', 'data', 'title'] }),
      em.find(ResourceRecord, { where: { companyId: c, type: 'finance-categories' }, select: ['id', 'title', 'data', 'status'] }),
      em.find(ResourceRecord, { where: { companyId: c, type: EXCLUSIVE_TYPE, status: 'active' } }),
      em.find(FlowRun, { where: { companyId: c, templateKey: EXCLUSIVE_TEMPLATE, status: 'running' } }),
      familyMembers(em, c),
    ]);
    const now = new Date().toISOString();
    const grantByFamily = new Map<string, ResourceRecord>();
    for (const g of grants) if (str(g.data.startsAt) <= now && str(g.data.endsAt) > now && !grantByFamily.has(str(g.data.familyKey))) grantByFamily.set(str(g.data.familyKey), g);
    const pendingByFamily = new Map<string, FlowRun>();
    for (const r of runs) { const f = members.get(Number(r.payload.baseCodeId))?.familyKey; if (f && !pendingByFamily.has(f)) pendingByFamily.set(f, r); }
    const requesterIds = [...new Set([...pendingByFamily.values()].map((r) => r.requesterId))];
    const names = new Map<number, string>();
    if (requesterIds.length) for (const u of await em.query('SELECT id, name FROM users WHERE company_id = ? AND id IN (?)', [c, requesterIds])) names.set(u.id, u.name);

    const catName = new Map(cats.map((x) => [x.id, str(x.data.name) || x.title]));
    const catParent = new Map(cats.map((x) => [x.id, x.data.parentId ? Number(x.data.parentId) : null]));
    const inCategory = (id: number | null): boolean => {
      if (!q.categoryId) return true;
      const seen = new Set<number>();
      while (id && !seen.has(id)) { if (id === q.categoryId) return true; seen.add(id); id = catParent.get(id) ?? null; }
      return false;
    };
    const prod = new Map(products.map((p) => [p.id, p]));
    const kw = (q.keyword ?? '').trim().toLowerCase().slice(0, 50);
    const rows: Array<Record<string, unknown>> = [];
    for (const bc of codes) {
      if (bc.data.canonicalId || ['disabled', 'archived'].includes(bc.status)) continue;
      const composed = bc.data.origin === 'composed';
      const p = prod.get(Number(bc.data.productId));
      const categoryId = Number((composed ? bc.data.codeCategoryId : (bc.data.categoryId ?? p?.data.categoryId)) ?? 0) || null;
      if (!inCategory(categoryId)) continue;
      const name = str(bc.data.name) || bc.title;
      if (kw && !`${name} ${bc.title} ${bc.searchText ?? ''}`.toLowerCase().includes(kw)) continue;
      const fam = members.get(bc.id)?.familyKey ?? '';
      const g = grantByFamily.get(fam);
      const run = pendingByFamily.get(fam);
      const row = {
        id: bc.id, code: bc.title, name, categoryId, categoryName: categoryId ? catName.get(categoryId) ?? '' : '',
        exclusive: g ? { ownerName: str(g.data.ownerName), endsAt: str(g.data.endsAt), mine: Number(g.data.ownerId) === user.id } : null,
        pending: run ? { runId: run.id, requesterName: names.get(run.requesterId) ?? '', mine: run.requesterId === user.id } : null,
      };
      if (q.onlyFree && (row.exclusive || row.pending)) continue;
      rows.push(row);
    }
    rows.sort((a, b) => String(a.code).localeCompare(String(b.code)));
    const free = rows.filter((r) => !r.exclusive && !r.pending).length;
    return {
      total: rows.length, free, capped: rows.length > PAGE_CAP, rows: rows.slice(0, PAGE_CAP),
      categories: cats.filter((x) => x.status !== 'stopped').map((x) => ({ id: x.id, name: str(x.data.name) || x.title, parentId: catParent.get(x.id) ?? null })),
    };
  }

  /** 专属记录与历史：生效中、已到期、已取消。能不能取消按“本人 / 原审批人 / 管理员”算。 */
  async grants(user: AuthUser) {
    const all = await this.ds.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: EXCLUSIVE_TYPE }, order: { id: 'DESC' }, take: 300 });
    const now = new Date().toISOString();
    return {
      rows: all.map((g) => {
        const status = g.status === 'cancelled' ? 'cancelled' : str(g.data.endsAt) <= now ? 'expired' : 'active';
        const mine = Number(g.data.ownerId) === user.id || Number(g.data.approverId) === user.id;
        return {
          id: g.id, productName: str(g.data.productName), ownerName: str(g.data.ownerName), approverName: str(g.data.approverName), runId: Number(g.data.runId) || null,
          startsAt: str(g.data.startsAt), endsAt: str(g.data.endsAt), status, cancelReason: status === 'cancelled' ? g.statusReason ?? '' : '', cancelledAt: str(g.data.cancelledAt) || null,
          canCancel: status === 'active' && (mine || user.permissions.isCompanyAdmin),
        };
      }),
    };
  }

  /** 取消专属：本人放弃，或原审批人、管理员取消，必须写原因。权限在这里判断，再用流程身份落到专属记录上（这类记录不能手工改）。 */
  async cancel(user: AuthUser, id: number, reason: string) {
    const g = await this.ds.manager.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type: EXCLUSIVE_TYPE } });
    if (!g) throw new NotFoundException('没有这条专属记录');
    if (!reason.trim()) throw new BadRequestException('取消专属需要填写原因');
    const mine = Number(g.data.ownerId) === user.id || Number(g.data.approverId) === user.id;
    if (!mine && !user.permissions.isCompanyAdmin) throw new ForbiddenException('只有专属人本人、原审批人或管理员可以取消专属');
    const engine: AuthUser = { ...user, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    // 记录里的“本人/原审批人”判断在 beforeExclusive 里按真实操作人再查一次，所以这里保留 user.id
    await this.resources.changeStatus(engine, EXCLUSIVE_TYPE, id, 'cancelled', reason.trim());
    return { ok: true };
  }
}
