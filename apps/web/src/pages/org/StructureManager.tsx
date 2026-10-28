import { useState } from 'react';
import type { DepartmentNode } from './orgApi';
import { ancestorsOf, findNode, type Placement } from './deptMove';

/**
 * 管理架构（旧版“管理组织架构”弹窗）：按层级分列，选中一级部门后右边出现它的下级；
 * 每一行可以拖动调整顺序/层级、上架/下架、编辑、删除；每一列顶上“新增”建在该列的上级之下。
 */
export function StructureManager({ tree, headcount, posCount, selectedId, can, message, onClose, onSelect, onAdd, onEdit, onDelete, onToggleStatus, onDropMove }: {
  tree: DepartmentNode[]; headcount: Map<number, number>; posCount: Map<number, number>; selectedId: number | null;
  can: { create: boolean; edit: boolean; delete: boolean };
  message: string; onClose: () => void; onSelect: (id: number) => void;
  onAdd: (parent: DepartmentNode | null) => void; onEdit: (n: DepartmentNode) => void; onDelete: (n: DepartmentNode) => void;
  onToggleStatus: (n: DepartmentNode) => void; onDropMove: (src: number, target: number, placement: Placement) => void;
}) {
  const path = selectedId ? [...(ancestorsOf(tree, selectedId) ?? []), selectedId] : [];
  const [dragId, setDragId] = useState<number | null>(null);
  const [hint, setHint] = useState<{ id: number | null; placement: Placement | 'append' } | null>(null);
  const columns = Math.max(3, path.length + 1);
  const total = (nodes: DepartmentNode[]): number => nodes.reduce((n, d) => n + 1 + total(d.children), 0);
  const where = (e: React.DragEvent<HTMLElement>): Placement => { const r = e.currentTarget.getBoundingClientRect(); const y = e.clientY - r.top; return y < r.height * 0.25 ? 'before' : y > r.height * 0.75 ? 'after' : 'inside'; };
  const end = () => { setDragId(null); setHint(null); };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal card org-manager" role="dialog" aria-modal="true" aria-label="管理组织架构">
        <header className="org-manager-head">
          <div>
            <small className="muted">组织架构 · 层级与状态</small>
            <h2>管理组织架构</h2>
            <p className="muted">按层级维护部门；拖动部门调整同级顺序或移到别的部门下，也可直接上架、下架。</p>
          </div>
          <button type="button" className="secondary-button" onClick={onClose}>完成</button>
        </header>
        <div className="org-manager-cols">
          {Array.from({ length: columns }, (_, level) => {
            const parentId = level === 0 ? null : path[level - 1] ?? null;
            const parent = parentId ? findNode(tree, parentId) : null;
            const waiting = level > 0 && !parent;
            const rows = level === 0 ? tree : parent?.children ?? [];
            return (
              <section className="org-manager-col" key={`${level}-${parentId ?? 'root'}`} aria-label={`${level + 1}级部门`}>
                <header>
                  <strong>{level + 1}级部门</strong>
                  {can.create && <button type="button" className="link-button" disabled={waiting} aria-label={`在${level + 1}级新增部门`} onClick={() => onAdd(parent)}>＋ 新增</button>}
                </header>
                <div
                  className={`org-manager-list${hint?.id === null && dragId !== null ? ' drop-append' : ''}`}
                  onDragOver={(e) => { if (dragId === null || waiting || !can.edit) return; e.preventDefault(); setHint({ id: null, placement: 'append' }); }}
                  onDrop={(e) => {
                    if (dragId === null || waiting || !can.edit) return;
                    e.preventDefault(); const src = dragId; end();
                    if (parent) onDropMove(src, parent.id, 'inside');
                    else if (rows.length) onDropMove(src, rows[rows.length - 1].id, 'after');
                  }}
                >
                  {waiting ? <div className="org-manager-empty"><strong>先选择上一级部门</strong><span>选择后这里显示它的下级部门</span></div>
                    : rows.length === 0 ? <div className="org-manager-empty"><strong>{level === 0 ? '暂无一级部门' : '暂无下级部门'}</strong><span>点右上角“新增”建立部门</span></div>
                    : rows.map((d) => {
                      const inactive = d.status === 'inactive';
                      const h = hint?.id === d.id ? hint.placement : null;
                      return (
                        <div
                          key={d.id}
                          className={`org-manager-row${path[level] === d.id ? ' selected' : ''}${inactive ? ' inactive' : ''}${dragId === d.id ? ' dragging' : ''}${h ? ` drop-${h}` : ''}`}
                          onDragOver={(e) => { if (dragId === null || dragId === d.id || !can.edit) return; e.preventDefault(); e.stopPropagation(); setHint({ id: d.id, placement: where(e) }); }}
                          onDrop={(e) => { if (dragId === null || dragId === d.id || !can.edit) return; e.preventDefault(); e.stopPropagation(); const pl = where(e); const src = dragId; end(); onDropMove(src, d.id, pl); }}
                        >
                          <button type="button" className="org-manager-pick" aria-pressed={path[level] === d.id} onClick={() => onSelect(d.id)}>
                            <strong>{d.name}</strong>
                            <small className="muted">{headcount.get(d.id) ?? 0} 人 · {posCount.get(d.id) ?? 0} 岗</small>
                          </button>
                          <span className={inactive ? 'pill warn' : 'pill ok'}>{inactive ? '已下架' : '已上架'}</span>
                          <span className="org-manager-acts">
                            {can.edit && <button type="button" className="org-drag" title="拖动调整顺序或层级" aria-label={`拖动${d.name}调整顺序或层级`} draggable
                              onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(d.id)); setDragId(d.id); }} onDragEnd={end}>⋮⋮</button>}
                            {can.edit && <button type="button" className="link-button" aria-label={`${inactive ? '上架' : '下架'}${d.name}`} onClick={() => onToggleStatus(d)}>{inactive ? '上架' : '下架'}</button>}
                            {can.edit && <button type="button" className="link-button" aria-label={`编辑${d.name}`} onClick={() => onEdit(d)}>编辑</button>}
                            {can.delete && <button type="button" className="link-button danger-text" aria-label={`删除${d.name}`} onClick={() => onDelete(d)}>删除</button>}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </section>
            );
          })}
        </div>
        <footer className="org-manager-foot">
          <span className={message ? 'error-text' : 'muted'} role={message ? 'alert' : undefined}>{message || '抓住 ⋮⋮ 拖动：落在行中间＝移入该部门下，落在上下边缘＝调整顺序，落在列空白处＝追加到这一列末尾。'}</span>
          <span className="muted">{total(tree)} 个部门</span>
        </footer>
      </section>
    </div>
  );
}
