import type { ResourceDto } from './api';

export interface RowGroup { key: string; label: string; depth: number; rows: ResourceDto[]; /** 按文本/单选字段分组时，这个分组的字段取值（新增时预填） */ value?: string; /** 归在这个分组下新增时要预填的引用值（部门 id）；“未分类”没有 */ refId?: number }
export interface DeptRef { id: number; name: string; parentId?: number | null }

/**
 * 列表按引用字段分组（配置 listGroupBy，如职责组按所属部门）：
 * 分组顺序按部门树（同级按部门排序），下级部门缩进；没填的归 emptyLabel，排在最后；部门已被删（目录里找不到）的用记录自带的名称。
 */
export function groupRowsByDept(rows: ResourceDto[], field: string, emptyLabel: string, depts: DeptRef[], thenBy?: string): RowGroup[] {
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
  const ordered = [...known, ...orphan, ...(none.rows.length ? [none] : [])];
  return thenBy ? ordered.flatMap((g) => splitByText(g, thenBy)) : ordered;
}

/** 部门分组里再按一个文字字段（如服务商）分小组：小组名“部门 · 服务商”，缩进比部门多一级，没填的归“未设置”；只有一个小组也照样分，保持每个部门结构一致 */
function splitByText(g: RowGroup, field: string): RowGroup[] {
  const by = new Map<string, ResourceDto[]>();
  for (const r of g.rows) { const v = String(r.data[field] ?? '').trim() || '未设置'; by.set(v, [...(by.get(v) ?? []), r]); }
  return [...by.entries()].map(([v, rows]) => ({ key: `${g.key}|${v}`, label: `${g.label} · ${v}`, depth: g.depth, refId: g.refId, rows }));
}

/** 取值里第一个数字（“第31类 饲料种籽” → 31），用来让类别按数字而不是按字符排序 */
const firstNum = (t: string) => { const m = /\d+/.exec(t); return m ? Number(m[0]) : Infinity; };

/**
 * 按文本/单选字段的取值分组（配置 listGroupBy.order = 'value'）：每个不同取值一组，组名用 labelOf 显示；
 * 取值里带数字的按数字排（第5类 在 第31类 前面），其余按拼音；没填的归 emptyLabel，排在最后。
 */
export function groupRowsByValue(rows: ResourceDto[], field: string, emptyLabel: string, labelOf: (row: ResourceDto) => string): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  const none: RowGroup = { key: 'none', label: emptyLabel, depth: 0, rows: [] };
  for (const r of rows) {
    const raw = r.data[field];
    if (raw === undefined || raw === null || raw === '') { none.rows.push(r); continue; }
    const key = String(raw);
    const g = groups.get(key) ?? { key, label: labelOf(r) || key, depth: 0, value: key, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => firstNum(a.label) - firstNum(b.label) || a.label.localeCompare(b.label, 'zh'));
  return [...list, ...(none.rows.length ? [none] : [])];
}
