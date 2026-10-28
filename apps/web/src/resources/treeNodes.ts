import { resourceApi, type ResourceDto } from './api';

/** 树形资料（资产分类、位置）的一个节点：只留浏览、点选和排序要用的字段。 */
export interface TreeNode {
  id: number;
  title: string;
  parentId: number;
  sort: number;
  status: string;
  scope: string;
  locationType: string;
  fixedAssetId: number;
  code: string;
  data: Record<string, unknown>;
}

const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);

export function toNode(r: ResourceDto): TreeNode {
  const d = r.data;
  return {
    id: r.id,
    title: r.title,
    parentId: num(d.parentId),
    sort: Number(d.sort) || 0,
    status: r.status,
    scope: String(d.scope ?? ''),
    locationType: String(d.locationType ?? ''),
    fixedAssetId: num(d.fixedAssetId),
    code: String(d.code ?? ''),
    data: d,
  };
}

/** 同一级里：先按排序值，再按编号 */
export const bySort = (a: TreeNode, b: TreeNode) => a.sort - b.sort || a.id - b.id;

/** 分页取完某类资料的全部记录（含停用）。一页 200 条，最多取 5000 条。 */
export async function loadAll(type: string, extra: { showHidden?: boolean } = {}): Promise<ResourceDto[]> {
  const out: ResourceDto[] = [];
  for (let page = 1; page <= 25; page++) {
    const r = await resourceApi.list(type, { page, pageSize: 200, showHidden: extra.showHidden ?? true });
    out.push(...r.items);
    if (out.length >= r.total || r.items.length === 0) break;
  }
  return out;
}

const cache = new Map<string, Promise<TreeNode[]>>();

export function loadTreeNodes(type: string): Promise<TreeNode[]> {
  let p = cache.get(type);
  if (!p) {
    p = loadAll(type).then((rows) => rows.map(toNode));
    p.catch(() => cache.delete(type));
    cache.set(type, p);
  }
  return p;
}

export function clearTreeNodes(type?: string) {
  if (type) cache.delete(type);
  else cache.clear();
}

export function childrenMap(nodes: readonly TreeNode[]): Map<number, TreeNode[]> {
  const m = new Map<number, TreeNode[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const p = n.parentId && ids.has(n.parentId) ? n.parentId : 0;
    m.set(p, [...(m.get(p) ?? []), n]);
  }
  for (const list of m.values()) list.sort(bySort);
  return m;
}

/** 从顶层到该节点的路径（最多 12 级，防环） */
export function pathOf(id: number, byId: ReadonlyMap<number, TreeNode>): TreeNode[] {
  const out: TreeNode[] = [];
  for (let n = byId.get(id), i = 0; n && i < 12; n = byId.get(n.parentId), i++) out.unshift(n);
  return out;
}

export function descendantIds(id: number, kids: ReadonlyMap<number, TreeNode[]>): number[] {
  const out = [id];
  for (let i = 0; i < out.length && out.length < 5000; i++) for (const c of kids.get(out[i]) ?? []) out.push(c.id);
  return out;
}
