import { createHash } from 'crypto';

/**
 * 聚水潭商品分类同步的差异计划（对照旧系统 category-sync-plan.js 的规则，纯函数，不碰数据库和外部系统）：
 * 动作 create 新增 / update 修改 / bind 关联已有 / disable 停用 / retire 收尾 / conflict 冲突 / none 无需处理。
 * 规则：最多 4 级；启用分类不能挂在停用父级；同名冲突不自动认领；外部被改动要人工核对；删除 = 停用。
 */
export interface LocalNode { id: string; name: string; parentId: string; sort: number; enable: boolean; depth?: number; path?: string }
export interface RemoteNode { id: string; name: string; parentId: string; sort: number | null; enable: boolean | null }
export interface LinkRow { localId: string; remoteId: string | null; status: string; local: Record<string, unknown> | null; remote: Record<string, unknown> | null; pending: Record<string, unknown> | null }
export interface Desired { name: string; parentId: string; sort: number; enable: boolean }
export interface PlanOp { localId: string; path: string; action: 'create' | 'update' | 'bind' | 'disable' | 'retire' | 'conflict' | 'none'; before: RemoteNode | Record<string, unknown> | null; after: Desired | (RemoteNode & { sort: number | null }) | null; message: string }

const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
export const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const eq = (a: unknown, b: unknown) => hash(a) === hash(b);
const key = (v: unknown) => String(v ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

export class PlanError extends Error {}

export function localTree(rows: { id: number; name: string; parentId: number | null; sort: number; enable: boolean }[]): LocalNode[] {
  const nodes: LocalNode[] = rows.map((r) => ({ id: String(r.id), name: r.name, parentId: r.parentId ? String(r.parentId) : '0', sort: r.sort, enable: r.enable }));
  const byId = new Map(nodes.map((r) => [r.id, r]));
  for (const node of nodes) {
    const chain = [node]; const seen = new Set([node.id]);
    let parent = node.parentId;
    while (parent !== '0') {
      if (seen.has(parent) || !byId.has(parent)) throw new PlanError('分类树存在循环或缺失父级，请先整理分类');
      seen.add(parent); chain.unshift(byId.get(parent)!); parent = byId.get(parent)!.parentId;
    }
    if (chain.length > 4) throw new PlanError('商品分类超过四级');
    node.depth = chain.length; node.path = chain.map((r) => r.name).join(' / ');
    if (node.enable && chain.some((r) => !r.enable)) throw new PlanError('启用的分类不能位于停用父级下');
  }
  return nodes.sort((a, b) => (a.depth! - b.depth!) || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

const matches = (remote: { name?: unknown; parentId?: unknown; sort?: unknown; enable?: unknown }, d: { name?: unknown; parentId?: unknown; sort?: unknown; enable?: unknown }) =>
  remote.name === d.name && remote.parentId === d.parentId && (remote.sort == null || remote.sort === d.sort) && (remote.enable == null || remote.enable === d.enable);
export const remoteMatches = matches;

export function buildPlan(o: { local: LocalNode[]; remote: RemoteNode[]; links: LinkRow[]; allLinks?: { localId: string; remoteId: string | null }[]; mode?: 'manual' | 'auto'; targetKey: string }) {
  const { local, remote, links, targetKey } = o;
  const allLinks = o.allLinks ?? links;
  const mode = o.mode ?? 'manual';
  const nodes = local;
  const byLocal = new Map(links.map((r) => [r.localId, r]));
  const byRemote = new Map(remote.map((r) => [r.id, r]));
  const resolved = new Map<string, string>();
  const operations: PlanOp[] = [];
  const names = new Map<string, number>();
  for (const n of nodes) { const k = key(n.name); names.set(k, (names.get(k) ?? 0) + 1); }
  const row = (n: LocalNode, action: PlanOp['action'], before: PlanOp['before'], after: PlanOp['after'], message = ''): PlanOp => ({ localId: n.id, path: n.path ?? n.name, action, before, after, message });
  const plain = (n: Record<string, unknown>) => ({ ...n, id: undefined, depth: undefined, path: undefined });
  for (const n of nodes) {
    const link = byLocal.get(n.id); const last = link?.local ?? null; const priorRemote = link?.remote ?? null;
    const parentId = n.parentId === '0' ? '0' : resolved.get(n.parentId);
    const desired: Desired = { name: n.name, parentId: parentId || `local:${n.parentId}`, sort: n.sort, enable: n.enable };
    const found = link?.remoteId ? byRemote.get(String(link.remoteId)) ?? null : null;
    let op: PlanOp;
    if ((names.get(key(n.name)) ?? 0) > 1) op = row(n, 'conflict', found, desired, 'OA 存在重名分类');
    else if (n.parentId !== '0' && !parentId) op = row(n, 'conflict', found, desired, '父级尚未解决冲突');
    else if (link?.remoteId && !found) op = row(n, 'conflict', priorRemote, desired, '已关联的聚水潭分类不存在，禁止自动重建');
    else if (link?.status === 'uncertain' && mode === 'auto') op = row(n, 'conflict', found, desired, '上次请求结果不明，请先手动核对');
    else if (found) {
      const collisions = remote.filter((r) => r.id !== found.id && key(r.name) === key(n.name));
      if (collisions.length) op = row(n, 'conflict', found, desired, '聚水潭存在其他同名分类');
      else if (priorRemote && !matches(found, priorRemote) && !(link!.status === 'uncertain' && link!.pending && matches(found, link!.pending))) op = row(n, 'conflict', found, desired, '聚水潭分类已被外部修改，请先核对两端资料');
      else {
        const change = !last || !eq(plain(last), plain(n as unknown as Record<string, unknown>));
        const needsWrite = link!.status !== 'linked' || change || !matches(found, desired);
        op = row(n, needsWrite ? 'update' : 'none', found, desired);
        resolved.set(n.id, found.id);
      }
    } else {
      const same = remote.filter((r) => key(r.name) === key(n.name));
      const candidate = same.length === 1 && same[0].name === n.name && same[0].parentId === desired.parentId ? same[0] : null;
      const owned = candidate && allLinks.some((r) => String(r.remoteId) === candidate.id && String(r.localId) !== n.id);
      if (candidate && !owned && mode === 'manual') { op = row(n, 'bind', candidate, desired, '关联已有分类，并按 OA 同步排序及启用状态'); resolved.set(n.id, candidate.id); }
      else if (same.length) op = row(n, 'conflict', candidate, desired, '同名分类需手动核对关联，自动同步不会认领或覆盖');
      else if (link?.status === 'uncertain') op = row(n, 'conflict', null, desired, '上次新增结果不明；请回查或在聚水潭确认，不能盲目重复新增');
      else if (n.enable) { op = row(n, 'create', null, desired); resolved.set(n.id, `local:${n.id}`); }
      else op = row(n, 'none', null, desired);
    }
    operations.push(op);
  }
  for (const link of links) {
    if (link.status === 'retired') continue; // 历史收尾记录，只留痕
    if (nodes.some((n) => n.id === link.localId)) continue;
    const last = link.local as { path?: string; enable?: boolean; sort?: number } | null;
    const found = byRemote.get(String(link.remoteId));
    if (!link.remoteId) { operations.push({ localId: link.localId, path: last?.path || '已删除分类', action: 'conflict', before: null, after: null, message: '已删除分类存在结果不明的新增请求，请人工核对' }); continue; }
    if (last?.enable === false && link.status === 'linked') continue;
    const after = found ? { ...found, sort: found.sort ?? last?.sort ?? 0, enable: false } : null;
    const hasChildren = remote.some((r) => r.parentId === String(link.remoteId) && !links.some((l) => String(l.remoteId) === r.id && (((l.local as { enable?: boolean } | null)?.enable === false && l.status === 'linked') || !nodes.some((n) => n.id === l.localId))));
    const drift = link.status === 'uncertain' && mode === 'auto' || (found && link.remote && !matches(found, link.remote) && !(mode === 'manual' && link.status === 'uncertain' && link.pending && matches(found, link.pending)));
    const action = !found && !hasChildren ? 'retire' : hasChildren || drift ? 'conflict' : 'disable';
    operations.push({ localId: link.localId, path: last?.path || '已删除分类', action, before: found ?? null, after, message: action === 'retire' ? '两端均已不存在，收尾历史关联' : drift ? '聚水潭分类已被外部修改' : hasChildren ? '远端仍有未停用的下级分类，请先处理下级' : '仅停用聚水潭分类，保留历史商品及映射' });
  }
  const depthOf = (id: string) => (byLocal.get(id)?.local as { depth?: number } | null)?.depth ?? 0;
  const changes = operations.filter((r) => r.action !== 'none').sort((a, b) => (a.action === 'disable' && b.action === 'disable' ? depthOf(b.localId) - depthOf(a.localId) : 0));
  const remoteOnly = remote.filter((r) => !links.some((l) => String(l.remoteId) === r.id) && !operations.some((op) => (op.before as RemoteNode | null)?.id === r.id));
  const conflicts = changes.filter((r) => r.action === 'conflict').length;
  return { targetKey, nodes, operations, changes, remoteOnly, conflicts, signature: hash({ targetKey, nodes, remote: [...remote].sort((a, b) => a.id.localeCompare(b.id)), links, operations }) };
}
