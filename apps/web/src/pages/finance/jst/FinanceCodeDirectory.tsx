import { FolderTree } from 'lucide-react';
import { useEffect,useMemo,useState } from 'react';
export interface CatNode { id: number; name: string; parentId: number | null }

/** 左侧分类目录：每个分类带本分类及下级的数量，点一下只看这个分类。分类的增删改和排序在“商品分类”页签里做。 */
export function FinanceCodeDirectory({ cats, counts, value, onPick, onManage, kicker = '商品编码分类' }: { kicker?:string; onManage?: () => void; cats: CatNode[]; counts: Record<number, number>; value: number | null; onPick: (id: number | null) => void }) {
  const kids = useMemo(() => {
    const m = new Map<number | null, CatNode[]>();
    for (const c of cats) m.set(c.parentId && cats.some((x) => x.id === c.parentId) ? c.parentId : null, [...(m.get(c.parentId && cats.some((x) => x.id === c.parentId) ? c.parentId : null) ?? []), c]);
    return m;
  }, [cats]);
  const total = (id: number): number => (counts[id] ?? 0) + (kids.get(id) ?? []).reduce((s, k) => s + total(k.id), 0);
  const [open, setOpen] = useState<Set<number>>(new Set());
  useEffect(() => { setOpen(current => current.size ? current : new Set(cats.filter(cat => !cat.parentId).map(cat => cat.id))); }, [cats]);
  const render = (parent: number | null, depth: number): JSX.Element[] =>
    (kids.get(parent) ?? []).flatMap((c) => {
      const has = (kids.get(c.id) ?? []).length > 0;
      const expanded = open.has(c.id);
      return [
        <li key={c.id} data-depth={depth} role="treeitem" aria-level={depth+1} aria-selected={c.id===value} aria-expanded={has?expanded:undefined} style={{ paddingLeft: depth * 14 }}>
          <div className={"code-category-entry"+(c.id===value?" active":"")}>{has ? <button type="button" className="code-category-expand" aria-label={expanded ? '收起' : '展开'} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })}>{expanded ? '▾' : '▸'}</button> : <span className="code-category-leaf"><i/></span>}
          <button type="button" className={c.id === value ? 'code-category-row active' : 'code-category-row'} onClick={() => { onPick(value === c.id ? null : c.id); if (has) setOpen(current => new Set([...current, c.id])); }}><span>{c.name}</span> <span className="code-category-count">{total(c.id)}</span></button></div>
        </li>,
        ...(has && expanded ? render(c.id, depth + 1) : []),
      ];
    });
  const all = Object.values(counts).reduce((s, n) => s + n, 0);
  return (
    <aside className="code-category-directory" aria-label="分类目录">
      <div className="between"><div><small>{kicker}</small><strong>分类目录</strong></div>{onManage&&<button type="button" className="link-button" onClick={onManage}><FolderTree size={16}/>管理分类</button>}</div>
      <ul className="code-category-tree" role="tree">
        <li><button type="button" className={value === null ? 'code-category-all active' : 'code-category-all'} onClick={() => onPick(null)}><span className="code-directory-all-label"><FolderTree size={16}/>全部商品</span> <span className="code-category-count">{all}</span></button></li>
        {render(null, 0)}
      </ul>

    </aside>
  );
}

