import { useState } from 'react';
import type { DepartmentNode } from './orgApi';
import type { Placement } from './deptMove';

/** 左侧部门树：人数、展开/收起（记住上次的展开状态）、点击选中；搜索命中时祖先自动展开。 */
export function DepartmentTree({ nodes, depth, selectedId, expanded, forceOpen, headcount, posCount, hits, onToggleOpen, onSelect, onDropMove }: {
  nodes: DepartmentNode[]; depth: number; selectedId: number | null; expanded: Set<number>; forceOpen: Set<number> | null; headcount: Map<number, number>; posCount: Map<number, number>; hits: Map<number, string[]>;
  onToggleOpen: (id: number) => void; onSelect: (id: number) => void;
  /** 有值才允许拖拽调整顺序/层级 */
  onDropMove?: (sourceId: number, targetId: number, placement: Placement) => void;
}) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [hint, setHint] = useState<{ id: number; placement: Placement } | null>(null);
  const place = (e: React.DragEvent<HTMLElement>): Placement => { const r = e.currentTarget.getBoundingClientRect(); const y = e.clientY - r.top; return y < r.height * 0.25 ? 'before' : y > r.height * 0.75 ? 'after' : 'inside'; };
  return (
    <ul className="tree" role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? '部门' : undefined}>
      {nodes.filter((n) => !forceOpen || forceOpen.has(n.id)).map((n) => {
        const open = forceOpen ? true : expanded.has(n.id);
        const kids = n.children.filter((c) => !forceOpen || forceOpen.has(c.id));
        const hit = hits.get(n.id);
        return (
          <li key={n.id} role="treeitem" aria-expanded={n.children.length ? open : undefined} aria-selected={selectedId === n.id}>
            <div
              className={`line-item org-node${selectedId === n.id ? ' active' : ''}${dragId === n.id ? ' dragging' : ''}${hint?.id === n.id ? ` drop-${hint.placement}` : ''}`}
              style={{ paddingLeft: 8 + depth * 16 }}
              draggable={!!onDropMove}
              aria-label={onDropMove ? `${n.name}，可拖动调整顺序或层级` : undefined}
              onDragStart={onDropMove ? (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(n.id)); setDragId(n.id); } : undefined}
              onDragEnd={onDropMove ? () => { setDragId(null); setHint(null); } : undefined}
              onDragOver={onDropMove ? (e) => { if (dragId === null || dragId === n.id) return; e.preventDefault(); setHint({ id: n.id, placement: place(e) }); } : undefined}
              onDrop={onDropMove ? (e) => { if (dragId === null || dragId === n.id) return; e.preventDefault(); const pl = place(e); const src = dragId; setDragId(null); setHint(null); onDropMove(src, n.id, pl); } : undefined}
            >
              {n.children.length > 0
                ? <button type="button" className="link-button org-toggle" aria-label={`${open ? '收起' : '展开'}${n.name}`} onClick={() => onToggleOpen(n.id)}>{open ? '▾' : '▸'}</button>
                : <span className="org-toggle" />}
              <button type="button" className="link-button org-name" onClick={() => onSelect(n.id)}>
                {n.name}{n.status === 'inactive' && <span className="pill warn"> 已停用</span>}
                {hit && <small className="muted"> 含 {hit.slice(0, 3).join('、')}{hit.length > 3 ? ` 等 ${hit.length} 人` : ''}</small>}
              </button>
              <span className="muted org-count" title="在职人数 · 岗位数">{headcount.get(n.id) ?? 0} 人 · {posCount.get(n.id) ?? 0} 岗</span>
            </div>
            {kids.length > 0 && open && <DepartmentTree nodes={kids} depth={depth + 1} selectedId={selectedId} expanded={expanded} forceOpen={forceOpen} headcount={headcount} posCount={posCount} hits={hits} onToggleOpen={onToggleOpen} onSelect={onSelect} onDropMove={onDropMove} />}
          </li>
        );
      })}
    </ul>
  );
}

