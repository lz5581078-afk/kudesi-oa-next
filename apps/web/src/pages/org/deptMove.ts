import type { DepartmentNode } from './orgApi';

export type Placement = 'before' | 'inside' | 'after';
export interface MoveUpdate { id: number; parentId: number | null; sortOrder: number }

function find(nodes: DepartmentNode[], id: number): DepartmentNode | null {
  for (const n of nodes) { if (n.id === id) return n; const f = find(n.children, id); if (f) return f; }
  return null;
}
function parentOf(nodes: DepartmentNode[], id: number, parent: DepartmentNode | null = null): DepartmentNode | null | undefined {
  for (const n of nodes) { if (n.id === id) return parent; const f = parentOf(n.children, id, n); if (f !== undefined) return f; }
  return undefined;
}

/** 拖拽调整：把 source 放到 target 的前面/后面（同级排序）或里面（成为子部门）。返回需要写回的 父部门+排序（步长 10），不能移动时返回错误文字。 */
export function planMove(tree: DepartmentNode[], sourceId: number, targetId: number, placement: Placement): { updates: MoveUpdate[] } | { error: string } {
  if (sourceId === targetId) return { error: '不能拖到自己上面' };
  const source = find(tree, sourceId); const target = find(tree, targetId);
  if (!source || !target) return { error: '找不到部门' };
  if (find(source.children, targetId)) return { error: '不能把部门移到它自己的下级里' };
  const newParent = placement === 'inside' ? target : (parentOf(tree, targetId) ?? null);
  const oldParent = parentOf(tree, sourceId) ?? null;
  const siblings = (newParent ? newParent.children : tree).filter((n) => n.id !== sourceId);
  let at = siblings.length;
  if (placement !== 'inside') { const i = siblings.findIndex((n) => n.id === targetId); at = placement === 'before' ? i : i + 1; }
  const next = [...siblings.slice(0, at), source, ...siblings.slice(at)];
  const parentId = newParent ? newParent.id : null;
  const updates: MoveUpdate[] = [];
  next.forEach((n, k) => {
    const sortOrder = (k + 1) * 10;
    if (n.id === sourceId ? true : n.sortOrder !== sortOrder) updates.push({ id: n.id, parentId, sortOrder });
  });
  const samePlace = (oldParent?.id ?? null) === parentId && updates.length === 1 && source.sortOrder === updates[0].sortOrder;
  return samePlace ? { updates: [] } : { updates };
}

/** 找出一个部门的所有祖先 id（从最上级到直接上级）；找不到返回 null。 */
export function ancestorsOf(nodes: DepartmentNode[], targetId: number, path: number[] = []): number[] | null {
  for (const n of nodes) {
    if (n.id === targetId) return path;
    const r = ancestorsOf(n.children, targetId, [...path, n.id]);
    if (r) return r;
  }
  return null;
}

export function findNode(nodes: DepartmentNode[], id: number): DepartmentNode | null {
  for (const n of nodes) { if (n.id === id) return n; const r = findNode(n.children, id); if (r) return r; }
  return null;
}
