import { EntityManager } from 'typeorm';
import { allowedCategoryValues, categoryFieldOf, mergeCategoryOptions, type CategoryOption, type CategoryOptionsPayload, type CategoryRow, type FieldDef, type ResourceDef } from '@kudesi/shared';
import { ResourceCategoryOption } from '../entities';

const toRow = (r: ResourceCategoryOption): CategoryRow => ({ value: r.value, label: r.label, sortOrder: r.sortOrder, hidden: r.hidden, custom: r.custom });

/** 该公司这个资料的分类配置行（只含 tabsBy 字段）；lock=true 在事务里加共享锁，防止校验到一半被删除 */
export async function loadCategoryRows(em: EntityManager, companyId: number, def: Pick<ResourceDef, 'key' | 'tabsBy' | 'fields' | 'tabSplit'>, opts: { lock?: 'read' | 'write' } = {}): Promise<CategoryRow[]> {
  const field = categoryFieldOf(def);
  if (!field) return [];
  const qb = em.createQueryBuilder(ResourceCategoryOption, 'o').where('o.companyId = :companyId AND o.resourceType = :type AND o.fieldKey = :field', { companyId, type: def.key, field: field.key }).orderBy('o.sortOrder', 'ASC').addOrderBy('o.id', 'ASC');
  if (opts.lock && em.queryRunner?.isTransactionActive) qb.setLock(opts.lock === 'write' ? 'pessimistic_write' : 'pessimistic_read');
  return (await qb.getMany()).map(toRow);
}

/** 有效选项（代码选项 + 公司配置）；该资料不开放分类管理时返回 undefined */
export async function categoryOptionsFor(em: EntityManager, companyId: number, def: ResourceDef): Promise<{ field: FieldDef; options: CategoryOption[] } | undefined> {
  const field = categoryFieldOf(def);
  if (!field) return undefined;
  return { field, options: mergeCategoryOptions(field.options ?? [], await loadCategoryRows(em, companyId, def)) };
}

/**
 * 保存记录时的取值校验：代码选项 + 本公司未隐藏的自建分类。公司没有自建分类时返回 undefined（沿用静态选项校验，零额外开销之外的一次查询）。
 * 提交的值是自建分类时在事务里加共享锁，和“删除分类”互斥。
 */
export async function categoryAllowedForSave(em: EntityManager, companyId: number, def: ResourceDef, submitted: unknown): Promise<Record<string, string[]> | undefined> {
  const field = categoryFieldOf(def);
  if (!field) return undefined;
  const lock = typeof submitted === 'string' && submitted.startsWith('c_');
  const rows = await loadCategoryRows(em, companyId, def, lock ? { lock: 'read' } : {});
  if (!rows.some((r) => r.custom)) return undefined;
  return { [field.key]: allowedCategoryValues(mergeCategoryOptions(field.options ?? [], rows)) };
}

/** 值 → 本公司显示名（导出、关联摘要用）；没有配置时返回 undefined，调用方用代码里的名称 */
export async function categoryLabels(em: EntityManager, companyId: number, def: ResourceDef): Promise<{ field: string; labels: Map<string, string> } | undefined> {
  const field = categoryFieldOf(def);
  if (!field) return undefined;
  const rows = await loadCategoryRows(em, companyId, def);
  if (!rows.length) return undefined;
  return { field: field.key, labels: new Map(mergeCategoryOptions(field.options ?? [], rows).map((o) => [o.value, o.label])) };
}

/** 前端用：本公司所有有配置的资料（只含用户有查看权限的） */
export async function categoryPayload(em: EntityManager, companyId: number, canView: (type: string) => boolean): Promise<CategoryOptionsPayload> {
  const rows = await em.find(ResourceCategoryOption, { where: { companyId }, order: { sortOrder: 'ASC', id: 'ASC' } });
  const out: CategoryOptionsPayload = {};
  for (const r of rows) {
    if (!canView(r.resourceType)) continue;
    (out[r.resourceType] ??= { field: r.fieldKey, rows: [] }).rows.push(toRow(r));
  }
  return out;
}

/** 导入：名称或值 → 值（只认未隐藏的）；hiddenHit 表示名称对上了但分类已隐藏 */
export function categoryFromText(options: readonly CategoryOption[], text: string): { value?: string; hiddenHit?: boolean } {
  const t = text.trim();
  const norm = (s: string) => s.normalize('NFKC').toLowerCase();
  const hit = options.find((o) => o.label === t) ?? options.find((o) => o.value === t) ?? options.find((o) => norm(o.label) === norm(t)) ?? options.find((o) => o.defaultLabel === t);
  if (!hit) return {};
  return hit.hidden ? { hiddenHit: true } : { value: hit.value };
}

/** 某资料页签字段的 值 → 本公司显示名（含代码里没改过的系统分类）；该资料不开放分类管理时是空表 */
export async function categoryLabelMap(em: EntityManager, companyId: number, type: string, def: ResourceDef): Promise<Map<string, string>> {
  const field = categoryFieldOf(def);
  if (!field || def.key !== type) return new Map();
  return new Map(mergeCategoryOptions(field.options ?? [], await loadCategoryRows(em, companyId, def)).map((o) => [o.value, o.label]));
}
