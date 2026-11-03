import { useEffect, useSyncExternalStore } from 'react';
import { optionsKindOf, optionsKindsOf, type FieldDef } from '@kudesi/shared';
import { api } from '../api/client';

/** 商品档案下拉用的“单位与规格”：种类 → [{取值, 名称}]；没维护的种类没有这一项，退回内置选项 */
export type UnitOptionsPayload = Record<string, Array<{ value: string; label: string }>>;

let cache: UnitOptionsPayload = {};
let loaded = false;
export const unitOptionsLoaded = () => loaded;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function loadUnitOptions(force = false): Promise<void> {
  if (loaded && !force) return Promise.resolve();
  if (inflight && !force) return inflight;
  inflight = api<UnitOptionsPayload>('/resources/unit-options')
    .then((p) => { cache = p; loaded = true; listeners.forEach((l) => l()); })
    .catch(() => { loaded = true; })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useUnitOptions(): UnitOptionsPayload {
  useEffect(() => { void loadUnitOptions(); }, []);
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => cache);
}

/** 这个字段现在能选的项：公司维护了就用公司的，没有就是资料配置里的内置选项 */
export function fieldOptions(field: FieldDef, values: Record<string, unknown>, units: UnitOptionsPayload) {
  const kind = optionsKindOf(field, values);
  const own = kind ? units[kind] : undefined;
  if (field.optionsFrom?.alsoKinds?.length) {
    const items = optionsKindsOf(field, values).flatMap((k, i) => units[k]?.length ? units[k] : i === 0 ? field.options ?? [] : []);
    const unique = new Map<string, { value: string; label: string }>();
    for (const item of items) if (!unique.has(item.value)) unique.set(item.value, item);
    return [...unique.values()];
  }
  if (kind === 'archive_type') return [...(field.options ?? []), ...(own ?? [])]; // 自定义档案类型接在内置类型后面
  return own && own.length > 0 ? own : field.options ?? [];
}

/** 显示用：取值 → 名称（用最近一次读到的列表） */
export function unitOptionLabel(field: FieldDef, values: Record<string, unknown>, value: string): string | undefined {
  const kind = optionsKindOf(field, values);
  return kind ? optionsKindsOf(field, values).flatMap(k => cache[k] ?? []).find(o => o.value === value)?.label : undefined;
}

export function resetUnitOptionsForTest(p: UnitOptionsPayload = {}, ready = true) { cache = p; loaded = ready; listeners.forEach((l) => l()); }
