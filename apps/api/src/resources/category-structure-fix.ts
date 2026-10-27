import { DataSource, EntityManager } from 'typeorm';
import { ResourceChangeLog, ResourceRecord } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { ResourcesService } from './resources.service';

/**
 * 迁入后的分类结构修正（只改线上已有数据；新迁入已在适配器里改好）：
 * 1. OEM 包装分类树独立：整棵树下只挂了 OEM 包装商品的，所属类型从 package 改为 oem_package。
 * 2. 供应商/客户分类恢复 4 级：旧迁入把第 3 级以后压成了“丙 / 丁”这样的一个名字，这里拆回两级。
 * 默认只出计划（dry-run）；执行要显式 apply，并先备份数据库。
 */
export interface OemMove { rootId: number; rootTitle: string; ids: number[]; oemProducts: number; packageProducts: number; decision: 'move' | 'keep' | 'ambiguous' }
export interface PartySplit { type: string; id: number; title: string; parentId: number | null; parts: string[] }
export interface FixPlan { oem: OemMove[]; split: PartySplit[] }

const PARTY = ['finance-supplier-categories', 'finance-customer-categories'] as const;
const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null);

export async function planCategoryFix(em: EntityManager, companyId: number): Promise<FixPlan> {
  const cats = await em.find(ResourceRecord, { where: { companyId, type: 'finance-categories' }, select: ['id', 'title', 'data'] });
  const kids = new Map<number, number[]>();
  for (const c of cats) { const p = num((c.data as Record<string, unknown>).parentId); if (p) kids.set(p, [...(kids.get(p) ?? []), c.id]); }
  const products = await em.find(ResourceRecord, { where: { companyId, type: 'finance-products' }, select: ['id', 'data'] });
  const oem: OemMove[] = [];
  for (const root of cats.filter((c) => !num((c.data as Record<string, unknown>).parentId) && (c.data as Record<string, unknown>).archiveType === 'package')) {
    const ids = [root.id];
    for (let i = 0; i < ids.length && ids.length < 500; i++) ids.push(...(kids.get(ids[i]) ?? []));
    const set = new Set(ids);
    let o = 0, p = 0;
    for (const pr of products) {
      const d = pr.data as Record<string, unknown>;
      if (!set.has(Number(d.categoryId))) continue;
      if (d.archiveType === 'oem_package') o++; else if (d.archiveType === 'package') p++;
    }
    oem.push({ rootId: root.id, rootTitle: root.title, ids, oemProducts: o, packageProducts: p, decision: o > 0 && p === 0 ? 'move' : p > 0 && o === 0 ? 'keep' : 'ambiguous' });
  }
  const split: PartySplit[] = [];
  for (const type of PARTY) {
    for (const r of await em.find(ResourceRecord, { where: { companyId, type }, select: ['id', 'title', 'data'] })) {
      const parts = r.title.split(' / ').map((x) => x.trim()).filter(Boolean);
      const parentId = num((r.data as Record<string, unknown>).parentId);
      if (parts.length > 1 && parentId) split.push({ type, id: r.id, title: r.title, parentId, parts });
    }
  }
  return { oem, split };
}

export async function applyCategoryFix(ds: DataSource, resources: ResourcesService, user: AuthUser, plan: FixPlan) {
  const done = { oemMoved: 0, split: 0 };
  await ds.transaction(async (em) => {
    for (const m of plan.oem.filter((x) => x.decision === 'move')) {
      for (const id of m.ids) {
        const r = await em.findOneOrFail(ResourceRecord, { where: { id, companyId: user.companyId, type: 'finance-categories' } });
        const before = { archiveType: (r.data as Record<string, unknown>).archiveType };
        r.data = { ...r.data, archiveType: 'oem_package' };
        await em.save(r);
        await em.insert(ResourceChangeLog, { companyId: user.companyId, resourceType: 'finance-categories', resourceId: id, action: 'update', actorId: user.id, beforeJson: before as never, afterJson: { archiveType: 'oem_package' } as never, note: 'OEM 包装分类树独立（迁入后修正）' });
        done.oemMoved++;
      }
    }
  });
  for (const s of plan.split) {
    // 前面的段建成上下级（已有同名同上级的直接用），最后一段仍用原记录，引用它的资料不用改
    let parent = s.parentId!;
    for (const part of s.parts.slice(0, -1)) {
      const exist = (await ds.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: s.type }, select: ['id', 'title', 'data'] }))
        .find((x) => x.title === part && num((x.data as Record<string, unknown>).parentId) === parent);
      parent = exist ? exist.id : (await resources.create(user, s.type, { name: part, parentId: parent })).id;
    }
    await resources.update(user, s.type, s.id, { name: s.parts[s.parts.length - 1], parentId: parent });
    done.split++;
  }
  return done;
}
