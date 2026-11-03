import { useEffect, useState } from 'react';

export interface CatNode { id: number; name: string; parentId: number | null; children: CatNode[]; count: number }

/** 把平铺的分类整理成树；count = 自己和所有下级分类下的工作项目数 */
export function buildCategoryTree(cats: Array<{ id: number; title: string; data: Record<string, unknown> }>, itemCategoryIds: Array<number | null>): CatNode[] {
  const ordered = [...cats].sort((a, b) => Number(a.data.sortOrder ?? 0) - Number(b.data.sortOrder ?? 0) || a.title.localeCompare(b.title, 'zh-CN'));
  const nodes = new Map<number, CatNode>(ordered.map((c) => [c.id, { id: c.id, name: c.title, parentId: typeof c.data.parentId === 'number' ? c.data.parentId : null, children: [], count: 0 }]));
  const roots: CatNode[] = [];
  for (const n of nodes.values()) (n.parentId !== null && nodes.get(n.parentId) ? nodes.get(n.parentId)!.children : roots).push(n);
  const sum = (n: CatNode): number => { n.count = itemCategoryIds.filter((id) => id === n.id).length + n.children.reduce((t, c) => t + sum(c), 0); return n.count; };
  roots.forEach(sum);
  return roots;
}
export const subtreeIds = (n: CatNode): number[] => [n.id, ...n.children.flatMap(subtreeIds)];
export const findNode = (roots: CatNode[], id: number | null): CatNode | null => {
  for (const r of roots) { if (r.id === id) return r; const f = findNode(r.children, id); if (f) return f; }
  return null;
};

/** 人工项目的只读归档目录；维护统一由FinanceCategoryManager负责。 */
export function CategoryTree({ versionId, tree, selected, onSelect }: { versionId: number; tree: CatNode[]; selected: number | null; onSelect: (id: number) => void }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  useEffect(() => setExpanded(new Set()), [versionId]);
  const toggle = (id: number) => setExpanded(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const render = (node: CatNode, depth: number) => <li key={node.id}>
    <div className={`labor-tree-row${node.id === selected ? ' selected' : ''}`} style={{ paddingLeft: depth * 16 + 5 }}>
      <button type="button" className="labor-tree-toggle" disabled={!node.children.length} aria-label={node.children.length ? `${expanded.has(node.id) ? '收起' : '展开'}${node.name}` : `${node.name}没有下级分类`} aria-expanded={node.children.length ? expanded.has(node.id) : undefined} onClick={() => toggle(node.id)}>{node.children.length ? expanded.has(node.id) ? '⌄' : '›' : ''}</button>
      <button type="button" className="labor-tree-label" aria-current={node.id === selected} aria-expanded={node.children.length ? expanded.has(node.id) : undefined} onClick={() => { onSelect(node.id); if (node.children.length) toggle(node.id); }}><span>{node.name}</span>{depth > 0 && <i>{depth + 1}</i>}<small>{node.count}</small>{node.id === selected && <span aria-hidden="true">✓</span>}</button>
    </div>
    {expanded.has(node.id) && node.children.length > 0 && <ul className="plain-list">{node.children.map(child => render(child, depth + 1))}</ul>}
  </li>;
  return <nav aria-label="项目归档分类" className="labor-tree-browse"><ul className="plain-list">{tree.map(node => render(node, 0))}</ul>{tree.length === 0 && <p className="muted">这个版本还没有归档分类。先建分类，再往里加工作项目（最多三级，项目放最末级）。</p>}</nav>;
}
