import { resourceApi, type ResourceDto } from './api';

export async function loadResourceDirectory(target: string, current: () => boolean, sortField?: string): Promise<ResourceDto[] | null> {
  const rows: ResourceDto[] = [];
  for (let page = 1; ; page++) {
    if (!current()) return null;
    const result = await resourceApi.list(target, { page, pageSize: 200, showHidden: true });
    if (!current()) return null;
    rows.push(...result.items);
    if (!result.items.length || rows.length >= result.total) break;
  }
  const active = [...new Map(rows.filter(row => row.status === 'active' && !row.archived).map(row => [row.id, row])).values()];
  const order = (row: ResourceDto) => Number(row.data[sortField ?? '']) || 0;
  return active.sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title, 'zh-CN') || a.id - b.id);
}
