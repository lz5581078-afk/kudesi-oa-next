import { useMemo, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ReasonDialog, RecordForm, clearRefCache } from '../../../resources/RecordForm';
import { resourceApi, type ResourceDto } from '../../../resources/api';

export interface CatNode { id: number; name: string; parentId: number | null; children: CatNode[]; count: number }

/** 把平铺的分类整理成树；count = 自己和所有下级分类下的工作项目数 */
export function buildCategoryTree(cats: Array<{ id: number; title: string; data: Record<string, unknown> }>, itemCategoryIds: Array<number | null>): CatNode[] {
  const nodes = new Map<number, CatNode>(cats.map((c) => [c.id, { id: c.id, name: c.title, parentId: typeof c.data.parentId === 'number' ? c.data.parentId : null, children: [], count: 0 }]));
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

/** 项目归档分类树（最多三级）：新增下级、修改（改名/换上级）、删除；工作项目只能放在最末级。 */
export function CategoryTree({ versionId, versionLocked, cats, tree, selected, canEdit, canDelete, onSelect, onChanged, total }: {
  versionId: number; versionLocked: boolean; cats: ResourceDto[]; tree: CatNode[]; selected: number | null; canEdit: boolean; canDelete: boolean; total: number;
  onSelect: (id: number | null) => void; onChanged: () => void;
}) {
  const [form, setForm] = useState<{ record: ResourceDto | null; parentId: number | null } | null>(null);
  const [removing, setRemoving] = useState<CatNode | null>(null);
  const byId = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);
  const render = (n: CatNode, depth: number) => (
    <li key={n.id}>
      <div className="between" style={{ paddingLeft: depth * 14 }}>
        <button type="button" className={n.id === selected ? 'tree-item active' : 'tree-item'} aria-current={n.id === selected} onClick={() => onSelect(n.id)}>{n.name} <span className="muted">({n.count})</span></button>
        {canEdit && !versionLocked && (
          <span className="row-actions">
            {depth < 2 && <button type="button" className="link-button" aria-label={`给${n.name}加下级`} onClick={() => setForm({ record: null, parentId: n.id })}>加下级</button>}
            <button type="button" className="link-button" aria-label={`修改${n.name}`} onClick={() => setForm({ record: byId.get(n.id) ?? null, parentId: n.parentId })}>改</button>
            {canDelete && <button type="button" className="link-button danger" aria-label={`删除${n.name}`} onClick={() => setRemoving(n)}>删</button>}
          </span>
        )}
      </div>
      {n.children.length > 0 && <ul className="plain-list">{n.children.map((c) => render(c, depth + 1))}</ul>}
    </li>
  );
  return (
    <nav aria-label="项目归档分类" className="card">
      <div className="between"><strong>项目归档分类</strong>{canEdit && !versionLocked && <button type="button" className="link-button" onClick={() => setForm({ record: null, parentId: null })}>+ 一级分类</button>}</div>
      <ul className="plain-list">
        <li><button type="button" className={selected === null ? 'tree-item active' : 'tree-item'} onClick={() => onSelect(null)}>全部 <span className="muted">({total})</span></button></li>
        {tree.map((n) => render(n, 0))}
      </ul>
      {tree.length === 0 && <p className="muted">这个版本还没有归档分类。先建分类，再往里加工作项目（最多三级，项目放最末级）。</p>}
      {form && <RecordForm def={getResourceDef('finance-labor-categories')!} record={form.record} initial={{ versionId, ...(form.parentId ? { parentId: form.parentId } : {}) }} lockedFields={['versionId']} onClose={() => setForm(null)} onSaved={() => { clearRefCache('finance-labor-categories'); setForm(null); onChanged(); }} />}
      {removing && <ReasonDialog title={`删除分类「${removing.name}」`} hint="分类下有下级分类或工作项目时不能删除，请先移走。" confirmLabel="确认删除" danger onClose={() => setRemoving(null)}
        onConfirm={async (reason) => { await resourceApi.remove('finance-labor-categories', removing.id, reason); clearRefCache('finance-labor-categories'); setRemoving(null); if (selected === removing.id) onSelect(null); onChanged(); }} />}
    </nav>
  );
}
