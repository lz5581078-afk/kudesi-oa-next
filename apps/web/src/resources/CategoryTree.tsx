import { useEffect, useMemo, useState } from 'react';
import { resourceApi, type CategoryTreeResult } from './api';

type Node = CategoryTreeResult['nodes'][number];

/** 列表左侧的分类目录：一眼看到该板块下所有分类和各自的数量，点一下就筛选（含下级）。 */
export function CategoryTree({ type, field, tab, status, showHidden, value, reloadKey, onSelect, onPath }: {
  type: string;
  field: string;
  tab: string;
  status: string;
  showHidden: boolean;
  value: string;
  reloadKey: unknown;
  onSelect: (id: string) => void;
  onPath?: (path: string) => void;
}) {
  const [tree, setTree] = useState<CategoryTreeResult | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [kw, setKw] = useState('');
  const [mOpen, setMOpen] = useState(false); // 手机上目录折叠成一行，点开再选

  useEffect(() => {
    let alive = true;
    resourceApi.categoryTree(type, { field, tab: tab || undefined, status: status || undefined, showHidden })
      .then((r) => { if (alive) { setTree(r); setError(''); } })
      .catch(() => alive && setError('分类目录加载失败'));
    return () => { alive = false; };
  }, [type, field, tab, status, showHidden, reloadKey]);

  const kids = useMemo(() => {
    const m = new Map<number, Node[]>();
    for (const n of tree?.nodes ?? []) m.set(n.parentId, [...(m.get(n.parentId) ?? []), n]);
    return m;
  }, [tree]);
  const byId = useMemo(() => new Map((tree?.nodes ?? []).map((n) => [n.id, n])), [tree]);

  // 默认展开一级；选中的分类，上面各级自动展开
  useEffect(() => {
    if (!tree) return;
    setOpen((cur) => {
      const next = new Set(cur.size ? cur : (kids.get(0) ?? []).map((n) => n.id));
      for (let n = byId.get(Number(value)), i = 0; n && n.parentId && i < 8; n = byId.get(n.parentId), i++) next.add(n.parentId);
      return next;
    });
  }, [tree, value, kids, byId]);

  useEffect(() => {
    if (!onPath) return;
    const parts: string[] = [];
    for (let n = byId.get(Number(value)), i = 0; n && i < 8; n = byId.get(n.parentId), i++) parts.unshift(n.title);
    onPath(parts.join(' / '));
  }, [value, byId, onPath]);

  const word = kw.trim().toLowerCase();
  // 搜索时：命中的分类及其所有上级都保留
  const keep = useMemo(() => {
    if (!word) return null;
    const s = new Set<number>();
    for (const n of tree?.nodes ?? []) {
      if (!n.title.toLowerCase().includes(word)) continue;
      for (let c: Node | undefined = n, i = 0; c && i < 8; c = byId.get(c.parentId), i++) s.add(c.id);
    }
    return s;
  }, [word, tree, byId]);

  const toggle = (id: number) => setOpen((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allParents = (tree?.nodes ?? []).filter((n) => kids.has(n.id)).map((n) => n.id);

  function rows(parentId: number, depth: number): JSX.Element[] {
    return (kids.get(parentId) ?? []).filter((n) => !keep || keep.has(n.id)).map((n) => {
      const sub = kids.get(n.id) ?? [];
      const expanded = keep ? true : open.has(n.id);
      const active = String(n.id) === value;
      return (
        <li key={n.id} role="treeitem" aria-expanded={sub.length ? expanded : undefined} aria-selected={active}>
          <div className={`cat-row${active ? ' active' : ''}${n.status !== 'active' ? ' stopped' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}>
            <button type="button" className="cat-toggle" tabIndex={-1} disabled={!sub.length} aria-label={expanded ? '收起' : '展开'} onClick={() => toggle(n.id)}>
              {sub.length ? (expanded ? '▾' : '▸') : '·'}
            </button>
            <button type="button" className="cat-name" title={n.title} onClick={() => onSelect(active ? '' : String(n.id))}>{n.title}</button>
            <span className="cat-count">{n.count}</span>
          </div>
          {sub.length > 0 && expanded && <ul role="group">{rows(n.id, depth + 1)}</ul>}
        </li>
      );
    });
  }

  return (
    <aside className="cat-tree" aria-label="分类目录">
      <button type="button" className="cat-fold" aria-expanded={mOpen} onClick={() => setMOpen((v) => !v)}>
        分类目录{value ? '（已选）' : ''} {mOpen ? '▴' : '▾'}
      </button>
      <div className={`cat-body${mOpen ? ' open' : ''}`} onClick={(e) => { if ((e.target as HTMLElement).closest('.cat-name, .cat-all')) setMOpen(false); }}>
      <div className="cat-head">
        <strong>分类目录</strong>
        {allParents.length > 0 && (
          <span className="cat-tools">
            <button type="button" onClick={() => setOpen(new Set(allParents))}>全部展开</button>
            <button type="button" onClick={() => setOpen(new Set())}>收起</button>
          </span>
        )}
      </div>
      <input className="cat-search" placeholder="找分类" aria-label="找分类" value={kw} onChange={(e) => setKw(e.target.value)} />
      <button type="button" className={`cat-all${value === '' ? ' active' : ''}`} onClick={() => onSelect('')}>
        <span>全部</span><span className="cat-count">{tree?.total ?? ''}</span>
      </button>
      {error && <div className="muted">{error}</div>}
      {tree && tree.nodes.length === 0 && <div className="muted">还没有分类，先到“资料维护”里建分类</div>}
      <ul role="tree">{rows(0, 0)}</ul>
      {tree && tree.uncategorized > 0 && <div className="muted cat-un">未归类 {tree.uncategorized} 条</div>}
      </div>
    </aside>
  );
}
