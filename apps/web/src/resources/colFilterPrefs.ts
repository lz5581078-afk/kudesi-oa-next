import { readTimeKeys, restrictedFieldKeys, validateColFilters, type ColFilter, type ResourceDef } from '@kudesi/shared';

/** 列筛选条件按资料类型记在本机：下次打开同一资料页还在，标签条能看到、能清掉。 */
const KEY = (type: string) => `kudesi.colfilter.${type}`;

export interface SavedColFilters { filters: ColFilter[]; labels: Record<string, string> }

/** 读出并重新校验：资料配置改了、权限变了而不再合法的条件直接丢掉，免得一打开列表就报错 */
export function readColFilters(def: ResourceDef, can: (permission: string) => boolean): SavedColFilters {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(def.key)) ?? 'null') as { filters?: unknown; labels?: unknown } | null;
    if (!raw || !Array.isArray(raw.filters)) return { filters: [], labels: {} };
    const restricted = restrictedFieldKeys(def, can);
    const ctx = { fields: def.fields, restricted, computed: readTimeKeys(def.key), statuses: def.statuses.map((s) => s.value) };
    const kept = raw.filters.filter((f) => validateColFilters([f], ctx).ok) as ColFilter[];
    const checked = validateColFilters(kept, ctx);
    const labels = raw.labels && typeof raw.labels === 'object' ? (raw.labels as Record<string, string>) : {};
    return { filters: checked.ok ? checked.filters : [], labels };
  } catch {
    return { filters: [], labels: {} };
  }
}

export function writeColFilters(type: string, saved: SavedColFilters) {
  try {
    if (!saved.filters.length) localStorage.removeItem(KEY(type));
    else localStorage.setItem(KEY(type), JSON.stringify(saved));
  } catch {
    /* 存储不可用时只是不记住 */
  }
}

/** 标签里用的名称表的键：同一列的同一个值 */
export const labelKey = (key: string, value: string) => `${key}|${value}`;
