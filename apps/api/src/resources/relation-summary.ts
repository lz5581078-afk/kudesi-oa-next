import { getResourceDef, type FieldDef } from '@kudesi/shared';
import type { ResourceRecord } from '../entities';

/**
 * 关联清单里每个对象的“关键信息”（旧系统的关联面板：对象名之外还带平台、编号、状态等）：
 * 取对方资料列表默认列里已填的前 3 项（只取选项、文本、数字、日期，不取金额、密码、证件号和有字段权限的列），再加状态。
 */
const PLAIN = new Set(['text', 'phone', 'select', 'number', 'date', 'monthday']);

function plain(f: FieldDef, v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (f.type === 'select') return f.options?.find((o) => o.value === String(v))?.label ?? String(v);
  return String(v);
}

export function relationSummary(r: Pick<ResourceRecord, 'type' | 'status' | 'data'>): string {
  const def = getResourceDef(r.type);
  if (!def) return '';
  const parts: string[] = [];
  for (const f of def.fields) {
    if (!f.list || f.key === def.titleField || f.readonly || f.permission || !PLAIN.has(f.type)) continue;
    const t = plain(f, (r.data as Record<string, unknown>)[f.key]);
    if (t) parts.push(t);
    if (parts.length === 3) break;
  }
  const st = def.statuses.find((x) => x.value === r.status);
  if (st && r.status !== def.defaultStatus) parts.push(st.label);
  return parts.join(' · ');
}

/** 关联是由哪个字段产生的：用那个字段的名称当关系名（如“手机号档案”“关联店铺”）；手动关联、未知字段返回空 */
export function relationFieldLabel(sourceType: string, relation: string, _direction: 'out' | 'in'): string | undefined {
  if (relation === 'manual') return undefined;
  return getResourceDef(sourceType)?.fields.find((f) => f.key === relation)?.label;
}
