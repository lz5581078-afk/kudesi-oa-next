import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../api/client';
import { jstApi, type CategoryNode } from '../pages/finance/jst/jstApi';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

/** 调整分类的先后：同一上级下拖动，或用 ▲▼；每次调整立即保存，只改顺序。 */
export function CategorySortDialog({ archiveType, onClose, onDone }: { archiveType: string; onClose: () => void; onDone: () => void }) {
  const [nodes, setNodes] = useState<CategoryNode[]>([]);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState<number | null>(null);
  const load = () => jstApi.categoryTree(archiveType).then((r) => setNodes(r.nodes)).catch((e) => setError(msg(e)));
  useEffect(() => { void load(); }, [archiveType]); // eslint-disable-line react-hooks/exhaustive-deps
  const kids = useMemo(() => {
    const m = new Map<number, CategoryNode[]>();
    for (const n of nodes) m.set(n.parentId, [...(m.get(n.parentId) ?? []), n]);
    return m;
  }, [nodes]);
  async function move(n: CategoryNode, toIndex: number) {
    const sibs = kids.get(n.parentId) ?? [];
    const from = sibs.findIndex((x) => x.id === n.id);
    if (from < 0 || toIndex < 0 || toIndex >= sibs.length || toIndex === from) return;
    const ids = sibs.map((x) => x.id);
    ids.splice(from, 1);
    ids.splice(toIndex, 0, n.id);
    setError('');
    try { await jstApi.categoryReorder(ids); await load(); onDone(); } catch (e) { setError(msg(e)); }
  }
  function list(parentId: number, depth: number): JSX.Element[] {
    const sibs = kids.get(parentId) ?? [];
    return sibs.map((n, i) => (
      <li key={n.id}>
        <div className={`cat-row${n.status !== 'active' ? ' stopped' : ''}`} style={{ paddingLeft: 6 + depth * 18 }} draggable
          onDragStart={() => setDrag(n.id)} onDragOver={(e) => { if (drag !== null) e.preventDefault(); }}
          onDrop={() => { const d = nodes.find((x) => x.id === drag); setDrag(null); if (d && d.parentId === n.parentId) void move(d, i); }}>
          <span aria-hidden>⠿</span>
          <span className="cat-name">{n.name}</span><span className="muted">{n.code}</span>
          <button type="button" className="icon-button" aria-label={`上移 ${n.name}`} disabled={i === 0} onClick={() => void move(n, i - 1)}>▲</button>
          <button type="button" className="icon-button" aria-label={`下移 ${n.name}`} disabled={i === sibs.length - 1} onClick={() => void move(n, i + 1)}>▼</button>
        </div>
        {(kids.get(n.id) ?? []).length > 0 && <ul>{list(n.id, depth + 1)}</ul>}
      </li>
    ));
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="调整分类顺序">
        <div className="modal-head between"><strong>调整分类顺序</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          <p className="muted">只能在同一个上级下调整先后；拖动或点 ▲▼，调整后立即保存。</p>
          <ul className="cat-sort">{list(0, 0)}</ul>
          {nodes.length === 0 && !error && <p className="muted">这一类下还没有分类</p>}
        </div>
        <div className="modal-foot"><button type="button" className="primary-button" onClick={onClose}>完成</button></div>
      </div>
    </div>
  );
}
