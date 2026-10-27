import { EntityManager } from 'typeorm';
import { FINANCE_RESOURCE_DEFS, PRODUCT_UNIT_CODED_KINDS, PRODUCT_UNIT_SEEDS, optionsKindOf, type FieldDef, type ResourceDef } from '@kudesi/shared';
import { ResourceRecord } from '../entities';

export const UNIT_RESOURCE = 'finance-product-units';

export interface UnitItem { code: string; name: string; active: boolean }
/** 种类 → 该公司维护的名称/编码列表 */
export type UnitLists = Map<string, UnitItem[]>;

/** 读公司维护的单位与规格列表（含已停用的，停用的只用于显示名称） */
export async function loadUnitLists(em: EntityManager, companyId: number): Promise<UnitLists> {
  const rows = await em.find(ResourceRecord, { where: { companyId, type: UNIT_RESOURCE } });
  const out: UnitLists = new Map();
  for (const r of rows) {
    const kind = String(r.data.kind ?? '');
    if (!kind) continue;
    const list = out.get(kind) ?? [];
    list.push({ code: String(r.data.code ?? ''), name: String(r.data.name ?? ''), active: r.status === 'active' });
    out.set(kind, list);
  }
  return out;
}

const isCoded = (kind: string) => (PRODUCT_UNIT_CODED_KINDS as readonly string[]).includes(kind);
/** 商品里存的值：有编码的种类存编码，系统规格存名称 */
const valueOf = (kind: string, i: UnitItem) => (isCoded(kind) ? i.code : i.name);

/** 这个字段当前允许的取值；公司没维护这一类时返回 undefined（退回静态选项） */
export function allowedValues(lists: UnitLists, field: FieldDef, values: Record<string, unknown>): string[] | undefined {
  const kind = optionsKindOf(field, values);
  if (!kind) return undefined;
  const items = (lists.get(kind) ?? []).filter((i) => i.active);
  if (kind === 'archive_type') return items.length > 0 ? [...(field.options ?? []).map((o) => o.value), ...items.map((i) => valueOf(kind, i)).filter(Boolean)] : undefined; // 自定义档案类型是在内置类型之外追加的
  return items.length > 0 ? items.map((i) => valueOf(kind, i)).filter(Boolean) : undefined;
}

/** 校验用：每个 optionsFrom 字段的允许取值 */
export function dynamicOptionsFor(def: ResourceDef, lists: UnitLists, values: Record<string, unknown>): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const f of def.fields) {
    if (!f.optionsFrom || f.optionsFrom.resource !== UNIT_RESOURCE) continue;
    const a = allowedValues(lists, f, values);
    if (a) out[f.key] = a;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 值 → 显示名（找不到原样返回，历史数据也能看） */
export function unitLabel(lists: UnitLists, kind: string, value: unknown): string {
  const v = String(value ?? '');
  if (!v) return '';
  const hit = (lists.get(kind) ?? []).find((i) => valueOf(kind, i) === v);
  if (hit) return hit.name;
  const def = FINANCE_RESOURCE_DEFS.find((d) => d.key === 'finance-products')!;
  const field = def.fields.find((f) => f.optionsFrom?.kind === kind);
  return field?.options?.find((o) => o.value === v)?.label ?? v;
}

/** 导入/导出：名称或编码 → 存的值 */
export function unitValueFromText(lists: UnitLists, kind: string, text: string): string | undefined {
  const t = text.trim();
  const items = (lists.get(kind) ?? []).filter((i) => i.active);
  const hit = items.find((i) => i.name === t) ?? items.find((i) => i.code && i.code.toLowerCase() === t.toLowerCase());
  return hit ? valueOf(kind, hit) : undefined;
}

/** 前端下拉用：每个种类的启用项（名称+取值） */
export function optionsPayload(lists: UnitLists): Record<string, Array<{ value: string; label: string }>> {
  const out: Record<string, Array<{ value: string; label: string }>> = {};
  for (const [kind, items] of lists) {
    const opts = items.filter((i) => i.active && valueOf(kind, i)).map((i) => ({ value: valueOf(kind, i), label: i.name }));
    if (opts.length) out[kind] = opts;
  }
  return out;
}

/** “导入默认项”：把预置的补进公司（已有同名或同编码的跳过），返回新增数；创建走资料保存流程 */
export async function seedUnitDefaults(em: EntityManager, companyId: number, create: (values: Record<string, unknown>) => Promise<unknown>): Promise<number> {
  const lists = await loadUnitLists(em, companyId);
  let n = 0;
  let order = 0;
  for (const [kind, name, code] of PRODUCT_UNIT_SEEDS) {
    order += 1;
    const cur = lists.get(kind) ?? [];
    if (cur.some((i) => i.name === name || (code && i.code === code))) continue;
    await create({ kind, name, code: code || undefined, sortOrder: order });
    n += 1;
  }
  return n;
}
