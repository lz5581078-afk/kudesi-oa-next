import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { categoryFieldOf, effectiveCategoryOptions, getResourceDef, selectableCategories, type CategoryOption, type CategoryOptionsPayload, type FieldDef, type Option } from '@kudesi/shared';
import { api } from '../api/client';

/**
 * 页签分类的“本公司有效选项”缓存：代码选项 + 公司配置（改名、排序、自建、隐藏）。
 * 页签、新建/编辑下拉、表格编辑、列筛选标签、详情显示都从这里取名称；管理弹窗改完调用 loadCategoryOptions(true) 立即刷新。
 * 换账号（登录/退出）时由 AuthContext 调用 resetCategoryOptions。
 */
let cache: CategoryOptionsPayload = {};
let version = 0;
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => { version += 1; listeners.forEach((l) => l()); };

export function loadCategoryOptions(force = false): Promise<void> {
  if (loaded && !force) return Promise.resolve();
  if (inflight && !force) return inflight;
  inflight = api<CategoryOptionsPayload>('/resources/category-options')
    .then((p) => { cache = p; loaded = true; emit(); })
    .catch(() => { loaded = true; })
    .finally(() => { inflight = null; });
  return inflight;
}

export function resetCategoryOptions(payload: CategoryOptionsPayload = {}, isLoaded = false) {
  cache = payload;
  loaded = isLoaded;
  inflight = null;
  emit();
}

function useVersion() {
  useEffect(() => { void loadCategoryOptions(); }, []);
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => version);
}

/** 该资料页签分类的有效选项；资料不开放分类管理时返回 undefined */
export function useCategoryOptions(type: string): CategoryOption[] | undefined {
  const v = useVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => { const def = getResourceDef(type); return def ? effectiveCategoryOptions(def, cache) : undefined; }, [type, v]);
}

/** 订阅缓存变化（用 categoryLabel 这类非 hook 取名称的组件在改名后需要重新渲染） */
export function useCategoryVersion(): number {
  return useVersion();
}

export function categoryOptionsOf(type: string): CategoryOption[] | undefined {
  const def = getResourceDef(type);
  return def ? effectiveCategoryOptions(def, cache) : undefined;
}

/** 这个字段是不是该资料的页签分类字段 */
export const isCategoryField = (type: string, fieldKey: string): boolean => {
  const def = getResourceDef(type);
  return !!def && categoryFieldOf(def)?.key === fieldKey;
};

/** 值 → 本公司显示名；已隐藏的自建分类加“（已隐藏）”。不是分类字段或查不到时返回 undefined */
export function categoryLabel(type: string, fieldKey: string, value: unknown): string | undefined {
  if (!isCategoryField(type, fieldKey)) return undefined;
  const o = categoryOptionsOf(type)?.find((x) => x.value === value);
  return o ? (o.hidden ? `${o.label}（已隐藏）` : o.label) : undefined;
}

/** 表单、表格编辑下拉用：未隐藏的 + 记录当前值；不是分类字段时返回 undefined（用字段自己的 options） */
export function categoryFieldChoices(type: string, field: FieldDef, current?: string): Option[] | undefined {
  if (!isCategoryField(type, field.key)) return undefined;
  const opts = categoryOptionsOf(type);
  return opts ? selectableCategories(opts, current) : undefined;
}

/** 显示/解析用：全部（含已隐藏）的 值+名称 */
export function categoryAllChoices(type: string, field: FieldDef): Option[] | undefined {
  if (!isCategoryField(type, field.key)) return undefined;
  return categoryOptionsOf(type)?.map((o) => ({ value: o.value, label: o.hidden ? `${o.label}（已隐藏）` : o.label }));
}

/**
 * 某个 select 字段现在的选项（统一入口）：页签分类字段用本公司的有效选项，其它字段沿用原来的（含“单位与规格”）。
 * mode='form'：编辑用，不含已隐藏的（记录当前值除外）；mode='display'：显示/筛选标签用，含已隐藏的（带“已隐藏”）。
 */
export function selectChoices(type: string, field: FieldDef, base: (f: FieldDef) => readonly Option[], opts: { mode: 'form' | 'display'; current?: string }): readonly Option[] {
  const own = opts.mode === 'form' ? categoryFieldChoices(type, field, opts.current) : categoryAllChoices(type, field);
  return own ?? base(field);
}
