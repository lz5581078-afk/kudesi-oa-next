import { resourceApi, type ResourceDto, type ListParams } from './api';

export async function loadResourceDirectory(target: string, current: () => boolean, sortField?: string, options?: { includeInactive?: boolean;preserveOrder?:boolean;showHidden?:boolean;scopedQuery?:Pick<ListParams,'tab'|'fieldKey'|'fieldValue'|'filters'|'referenceOrder'> }): Promise<ResourceDto[] | null> {
  // 一次完整读取固定一个真实目录范围，续页不能串入中途切换后的种类。
  const scope=options?.scopedQuery?{...options.scopedQuery}:{};
  const rows: ResourceDto[] = [], seen = new Set<number>();
  let total: number | null = null;
  for (let page = 1; ; page++) {
    if (!current()) return null;
    const result = await resourceApi.list(target, { ...scope, page, pageSize: 200, showHidden: options?.showHidden??true });
    if (!current()) return null;
    if (!Number.isSafeInteger(result.total) || result.total < 0 || !Array.isArray(result.items) || total !== null && result.total !== total) throw new Error('目录读取不完整，请重试');
    total = result.total;
    for (const row of result.items) {
      if (!Number.isSafeInteger(row.id) || row.id <= 0 || seen.has(row.id)) throw new Error('目录读取不完整，请重试');
      seen.add(row.id); rows.push(row);
    }
    if (seen.size > total || !result.items.length && seen.size < total) throw new Error('目录读取不完整，请重试');
    if (seen.size === total) break;
  }
  const visible = rows.filter(row => (options?.includeInactive || row.status === 'active') && !row.archived);
  if(options?.preserveOrder)return visible;
  const order = (row: ResourceDto) => Number(row.data[sortField ?? '']) || 0;
  return visible.sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title, 'zh-CN') || a.id - b.id);
}
