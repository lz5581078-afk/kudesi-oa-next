import type { ResourceDto } from './api';

export interface RowGroup { key: string; label: string; depth: number; rows: ResourceDto[]; /** 归在这个分组下新增时要预填的引用值（部门 id）；“未分类”没有 */ refId?: number }
export interface DeptRef { id: number; name: string; parentId?: number | null }

/**
 * 列表按引用字段分组（配置 listGroupBy，如职责组按所属部门）：
 * 分组顺序按部门树（同级按部门排序），下级部门缩进；没填的归 emptyLabel，排在最后；部门已被删（目录里找不到）的用记录自带的名称。
 */
export function groupRowsByDept(rows: ResourceDto[], field: string, emptyLabel: string, depts: DeptRef[]): RowGroup[] {
  const byId = new Map(depts.map((d) => [d.id, d]));
  const path = (id: number): string[] => {
    const out: string[] = [];
    const seen = new Set<number>();
    for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) { seen.add(cur.id); out.unshift(cur.name); }
    return out;
  };
  const depth = (id: number) => Math.max(0, path(id).length - 1);
  // 部门树的先序（目录已按同级排序）
  const order: number[] = [];
  const walk = (parent: number | null) => { for (const d of depts) if ((d.parentId ?? null) === parent && !order.includes(d.id)) { order.push(d.id); walk(d.id); } };
  walk(null);
  for (const d of depts) if (!order.includes(d.id)) order.push(d.id); // 父级不在目录里的也要有位置
  const groups = new Map<string, RowGroup>();
  const none: RowGroup = { key: 'none', label: emptyLabel, depth: 0, rows: [] };
  for (const r of rows) {
    const v = r.data[field];
    if (typeof v !== 'number') { none.rows.push(r); continue; }
    const g = groups.get(String(v)) ?? { key: String(v), label: path(v).join(' / ') || r.refLabels[field] || `部门 #${v}`, depth: depth(v), refId: v, rows: [] };
    g.rows.push(r);
    groups.set(g.key, g);
  }
  const known = order.filter((id) => groups.has(String(id))).map((id) => groups.get(String(id))!);
  const orphan = [...groups.values()].filter((g) => !known.includes(g));
  return [...known, ...orphan, ...(none.rows.length ? [none] : [])];
}
