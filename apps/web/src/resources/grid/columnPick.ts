import { getResourceDef, gridFieldAccess, gridLockedAfterCreate, gridStatusAccess, type FieldDef, type ResourceDef } from '@kudesi/shared';
import type { GridCol } from './gridModel';

/**
 * 表格编辑自己的列选择：列不再绑定列表页的“显示列”，按字段分组列出这个资料的全部字段（含列表里不显示的）。
 * 标识列（名称、编码）固定在最前且不能取消；选择按资料类型记在本机。
 */

export const STATUS_KEY = '$status';
export const childKey = (type: string, field: string) => `$child:${type}|${field}`;

export interface PickItem {
  key: string;
  label: string;
  group: string;
  fixed: boolean;
  editable: boolean;
  reason?: string;
  required: boolean;
  list: boolean;
  col: GridCol;
}

export interface PickCtx {
  can: (permission: string) => boolean;
  canSecret: boolean;
  canDisable: boolean;
  /** 能不能看某个子表资料（没有查看权限的子表不出现） */
  canView: (type: string) => boolean;
}

/** 候选列（也就是列的显示顺序）：名称 → 编码 → 状态 → 其余字段（按配置顺序）→ 统计列 → 子表 */
export function pickCandidates(def: ResourceDef, derived: readonly FieldDef[], ctx: PickCtx): PickItem[] {
  const visible = (f: FieldDef) => !(f.permission && !ctx.can(f.permission)) && !((f.type === 'secret') && !ctx.canSecret);
  const byKey = new Map(def.fields.map((f) => [f.key, f] as const));
  const idKeys = [def.titleField, def.uniqueField].filter((k, i, a): k is string => Boolean(k) && a.indexOf(k) === i && byKey.has(k!));
  const fieldItem = (f: FieldDef, fixed: boolean, isDerived: boolean): PickItem => {
    const a = isDerived ? ({ editable: false, reason: '统计数字，不能修改' } as const) : gridFieldAccess(f, ctx.can, ctx.canSecret);
    return {
      key: f.key, label: f.label, group: f.group, fixed, editable: a.editable, reason: a.editable ? undefined : a.reason, required: Boolean(f.required), list: Boolean(f.list),
      col: { key: f.key, label: f.label, field: f, kind: a.editable ? a.kind : null, editable: a.editable, reason: a.editable ? undefined : a.reason, lockedAfterCreate: gridLockedAfterCreate(def.key, f.key) ?? undefined },
    };
  };
  const out: PickItem[] = [];
  for (const k of idKeys) if (visible(byKey.get(k)!)) out.push(fieldItem(byKey.get(k)!, true, false));
  const st = gridStatusAccess(def, ctx.canDisable);
  out.push({
    key: STATUS_KEY, label: '状态', group: '状态', fixed: false, editable: st.editable, reason: st.editable ? undefined : st.reason, required: false, list: true,
    col: { key: STATUS_KEY, label: '状态', field: null, kind: st.editable ? 'select' : null, editable: st.editable, reason: st.editable ? undefined : st.reason, special: 'status', statuses: def.statuses },
  });
  for (const f of def.fields) if (!idKeys.includes(f.key) && visible(f)) out.push(fieldItem(f, false, false));
  for (const f of derived) if (!byKey.has(f.key)) out.push(fieldItem(f, false, true));
  const kids = [...(def.children ?? []).map((c) => [c, getResourceDef(c)?.parent?.field] as const), ...(def.related ?? []).map((r) => [r.type, r.field] as const)];
  for (const [type, field] of kids) {
    const cd = getResourceDef(type);
    if (!cd || !field || !ctx.canView(type) || out.some((x) => x.key === childKey(type, field))) continue;
    out.push({
      key: childKey(type, field), label: cd.label, group: '子表（点开弹出编辑）', fixed: false, editable: false, reason: '点开后在浮层里编辑', required: false, list: false,
      col: { key: childKey(type, field), label: cd.label, field: null, kind: null, editable: false, reason: '点开后在浮层里编辑', special: 'child', child: { type, field } },
    });
  }
  return out;
}

export type PresetId = 'editable' | 'list' | 'all' | 'required';
export const PRESETS: ReadonlyArray<{ id: PresetId; label: string; hint: string }> = [
  { id: 'editable', label: '可编辑字段', hint: '默认：所有能改的字段（再加列表里显示的只读列和子表）' },
  { id: 'list', label: '列表字段', hint: '和列表页默认显示的列一致' },
  { id: 'all', label: '全部字段', hint: '这个资料的所有字段，含只读的' },
  { id: 'required', label: '必填字段', hint: '名称、编码和所有必填字段' },
];

export function presetKeys(items: readonly PickItem[], preset: PresetId): string[] {
  const pick = (f: (i: PickItem) => boolean) => items.filter((i) => i.fixed || f(i)).map((i) => i.key);
  switch (preset) {
    case 'all': return items.map((i) => i.key);
    case 'list': return pick((i) => i.key === STATUS_KEY || i.list);
    case 'required': return pick((i) => i.required);
    default: return pick((i) => i.key === STATUS_KEY || i.col.special === 'child' || (i.editable && i.col.kind !== 'secret') || i.list);
  }
}

/** 把任意一组键整理成合法的选择：只留存在的、固定列必选、按候选顺序排 */
export function normalizeKeys(items: readonly PickItem[], keys: readonly string[]): string[] {
  const set = new Set(keys);
  return items.filter((i) => i.fixed || set.has(i.key)).map((i) => i.key);
}

const storeKey = (type: string) => `kudesi.grid.cols.${type}`;

export function loadPicked(type: string, items: readonly PickItem[]): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey(type)) ?? 'null') as string[] | null;
    if (Array.isArray(saved) && saved.length) return normalizeKeys(items, saved);
  } catch { /* 存储不可用：用默认 */ }
  return presetKeys(items, 'editable');
}

export function savePicked(type: string, keys: readonly string[]) {
  try { localStorage.setItem(storeKey(type), JSON.stringify(keys)); } catch { /* 记不住而已 */ }
}
