import { type ResourceDto } from './api';
import {loadResourceDirectory} from './resourceDirectory';
import {referenceCacheIdentity,referenceCacheVersion,subscribeReferenceCache} from './referenceOptionsCache';

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

/** 完整读取目录（含停用），保留服务端维护顺序；缺页不能当作完整的末级目录。 */
export async function loadAll(type: string, extra: { showHidden?: boolean } = {}, current:()=>boolean=()=>true): Promise<ResourceDto[]> {
  const rows=await loadResourceDirectory(type,current,undefined,{includeInactive:true,preserveOrder:true,showHidden:extra.showHidden??true});
  if(!rows)throw new Error('目录身份已变化，请重新读取');
  return rows;
}

const cache = new Map<string, Promise<TreeNode[]>>();
subscribeReferenceCache(()=>cache.clear());

export function loadTreeNodes(type: string): Promise<TreeNode[]> {
  const key=JSON.stringify([referenceCacheIdentity(),type]),revision=referenceCacheVersion();
  let p = cache.get(key);
  if (!p) {
    p = loadAll(type,{},()=>revision===referenceCacheVersion()).then((rows) => rows.map(toNode));
    const pending=p;void p.catch(() => {if(cache.get(key)===pending)cache.delete(key);});
    cache.set(key, p);
  }
  return p;
}

export function clearTreeNodes(type?: string) {
  if (type)for(const key of cache.keys()){if(JSON.parse(key)[1]===type)cache.delete(key);}
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
  const out = [id],seen=new Set(out);
  for (let i = 0; i < out.length; i++) for (const c of kids.get(out[i]) ?? [])if(!seen.has(c.id)){seen.add(c.id);out.push(c.id);}
  return out;
}
