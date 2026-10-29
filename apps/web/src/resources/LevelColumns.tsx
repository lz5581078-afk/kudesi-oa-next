import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { LOC_TYPE_LABEL, type Column, type Counts, type LocRow } from './locationColumns';

/** 层级小标签：全部 → 办公楼 → 楼层…，点哪一级回到哪一级 */
export function LevelCrumbs({ rootLabel, path, selectedId, onSelect }: { rootLabel: string; path: LocRow[]; selectedId: number; onSelect: (id: number) => void }) {
  return (
    <nav className="lc-crumbs" aria-label={`${rootLabel}路径`}>
      <button type="button" className={`lc-chip${selectedId === 0 ? ' on' : ''}`} aria-current={selectedId === 0 ? 'true' : undefined} onClick={() => onSelect(0)}>{rootLabel}</button>
      {path.map((l) => (
        <button key={l.id} type="button" className={`lc-chip${selectedId === l.id ? ' on' : ''}`} aria-current={selectedId === l.id ? 'true' : undefined} onClick={() => onSelect(l.id)}>{l.title}</button>
      ))}
    </nav>
  );
}

export interface ColumnOps {
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** 在 parent 下新增；返回后由外面刷新并选中 */
  onCreate: (v: { parentId: number; name: string; type: string }) => Promise<void>;
  onRename: (row: LocRow, name: string) => Promise<void>;
  /** 同一列里重新排好的顺序 */
  onReorder: (orderedIds: number[]) => Promise<void>;
  onToggle: (row: LocRow) => Promise<void>;
  onDelete: (row: LocRow) => void;
}

interface Props extends ColumnOps {
  columns: Column[];
  /** 当前选中的位置（0 = 没选） */
  selectedId: number;
  /** 这一块是不是当前在用（决定高亮选中项） */
  active: boolean;
  manage: boolean;
  noun: string;
  typeOptions: readonly string[];
  childType: (parent: LocRow | null) => string;
  counts: (id: number) => Counts;
  onSelect: (id: number) => void;
  emptyHint: string;
  /** 选中项没有下级时，管理态下补一列“暂无下级，可在这里新增” */
  trailing?: { parent: LocRow } | null;
}

/** 分级多列（像文件管理器的列视图）：每一级一列，点一项就在右边展开下一级；管理态下可就地新增、改名、停用、删除、拖动排序。 */
export function LevelColumns(p: Props) {
  const [adding, setAdding] = useState<{ parentId: number; name: string; type: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const parents = new Map<number, LocRow>();
  for (const c of p.columns) for (const r of c.rows) parents.set(r.id, r);

  useEffect(() => { if (!p.manage) { setAdding(null); setRenaming(null); } }, [p.manage]);
  // 选中后往右展开：手机上列是横向滚动的，把新出现的那一列滚进视野
  useEffect(() => { const el = box.current; if (el) el.scrollTo?.({ left: el.scrollWidth, behavior: 'smooth' }); }, [p.columns.length, p.selectedId]);

  const guard = async (fn: () => Promise<void>) => { setError(''); try { await fn(); } catch (e) { setError(e instanceof ApiError ? e.message : '操作失败'); } };
  const startAdd = (parentId: number) => { setRenaming(null); setAdding({ parentId, name: '', type: p.childType(parentId ? parents.get(parentId) ?? null : null) }); };
  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!adding || !adding.name.trim()) return;
    await guard(async () => { await p.onCreate({ parentId: adding.parentId, name: adding.name.trim(), type: adding.type }); setAdding(null); });
  }
  async function submitRename(e: React.FormEvent, row: LocRow) {
    e.preventDefault();
    if (!renaming || !renaming.name.trim()) return;
    await guard(async () => { await p.onRename(row, renaming.name.trim()); setRenaming(null); });
  }
  async function drop(target: LocRow, rows: LocRow[]) {
    const from = drag;
    setDrag(null);
    if (from == null || from === target.id) return;
    const moved = rows.find((r) => r.id === from);
    if (!moved) return; // 只能在同一列里排
    const next = rows.filter((r) => r.id !== from);
    next.splice(Math.max(0, next.findIndex((r) => r.id === target.id)), 0, moved);
    await guard(() => p.onReorder(next.map((r) => r.id)));
  }
  async function move(row: LocRow, rows: LocRow[], dir: -1 | 1) {
    const i = rows.findIndex((r) => r.id === row.id);
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    await guard(() => p.onReorder(next.map((r) => r.id)));
  }

  const addForm = (placeholder: string) => adding && (
    <form className="lc-add" onSubmit={submitAdd} aria-label={`新增${p.noun}`}>
      <select aria-label="类型" value={adding.type} onChange={(e) => setAdding({ ...adding, type: e.target.value })}>
        {p.typeOptions.map((t) => <option key={t} value={t}>{LOC_TYPE_LABEL[t] ?? t}</option>)}
      </select>
      <input autoFocus aria-label={`${p.noun}名称`} placeholder={placeholder} maxLength={60} value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
      <span className="lc-add-btns"><button type="submit" className="res-btn sm primary">保存</button><button type="button" className="res-btn sm" onClick={() => setAdding(null)}>取消</button></span>
    </form>
  );

  const first = p.columns[0];
  if (!first || (first.rows.length === 0 && p.columns.length === 1)) {
    return (
      <div className="lc-empty">
        {adding && adding.parentId === 0 ? addForm(`输入一级${p.noun}名称`) : (
          <>
            <strong>暂无{p.noun}</strong>
            <span>{p.emptyHint}</span>
            {p.manage && p.canCreate && <button type="button" className="res-btn sm" onClick={() => startAdd(0)}>新增一级{p.noun}</button>}
          </>
        )}
        {error && <small role="alert" className="lc-err">{error}</small>}
      </div>
    );
  }

  return (
    <>
      <div className="lc-cols" ref={box}>
        {p.columns.map((col) => (
          <section className="lc-col" key={`${col.title}-${col.parentId}`} aria-label={col.title}>
            <header><strong>{col.title}</strong>{p.manage && p.canCreate && <button type="button" className="link-button" onClick={() => startAdd(col.parentId)}>新增</button>}</header>
            <div className="lc-list">
              {adding && adding.parentId === col.parentId && addForm(`输入${p.noun}名称`)}
              {col.rows.map((row) => {
                const on = p.active && p.selectedId === row.id;
                const c = p.counts(row.id);
                const editing = renaming?.id === row.id;
                return (
                  <div
                    key={row.id}
                    className={`lc-item${on ? ' on' : ''}${row.status === 'inactive' ? ' stopped' : ''}${drag === row.id ? ' dragging' : ''}`}
                    draggable={p.manage && p.canEdit && !editing}
                    onDragStart={(e) => { if (!p.manage || editing) return; setDrag(row.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(row.id)); }}
                    onDragOver={(e) => { if (p.manage && drag != null) e.preventDefault(); }}
                    onDrop={(e) => { e.preventDefault(); void drop(row, col.rows); }}
                    onDragEnd={() => setDrag(null)}
                  >
                    {editing ? (
                      <form className="lc-edit" onSubmit={(e) => submitRename(e, row)}>
                        <input autoFocus aria-label={`${p.noun}名称`} maxLength={60} value={renaming!.name} onChange={(e) => setRenaming({ id: row.id, name: e.target.value })} />
                        <span className="lc-add-btns"><button type="submit" className="res-btn sm primary">保存</button><button type="button" className="res-btn sm" onClick={() => setRenaming(null)}>取消</button></span>
                      </form>
                    ) : (
                      <button type="button" className="lc-main" aria-pressed={on} onClick={() => p.onSelect(row.id)}>
                        <span className="lc-name">{row.title}</span>
                        <small>{LOC_TYPE_LABEL[row.locationType] ?? row.locationType ?? ''}</small>
                        {c.alerts > 0 && <i className="lc-dot" title={`${c.alerts} 份档案借出或遗失`} aria-label={`${c.alerts} 份档案借出或遗失`} />}
                        <em className="lc-n" aria-label={`${c.archives} 份档案`}>{c.archives}</em>
                      </button>
                    )}
                    {p.manage && !editing && (
                      <div className="lc-acts">
                        {p.canEdit && <button type="button" aria-label={`改名「${row.title}」`} onClick={() => { setAdding(null); setRenaming({ id: row.id, name: row.title }); }}>改名</button>}
                        {p.canEdit && <button type="button" aria-label={`${row.status === 'inactive' ? '启用' : '停用'}「${row.title}」`} onClick={() => void guard(() => p.onToggle(row))}>{row.status === 'inactive' ? '启用' : '停用'}</button>}
                        {p.canEdit && <button type="button" aria-label={`上移「${row.title}」`} disabled={col.rows[0].id === row.id} onClick={() => void move(row, col.rows, -1)}>↑</button>}
                        {p.canEdit && <button type="button" aria-label={`下移「${row.title}」`} disabled={col.rows[col.rows.length - 1].id === row.id} onClick={() => void move(row, col.rows, 1)}>↓</button>}
                        {p.canDelete && <button type="button" className="danger" aria-label={`删除「${row.title}」`} onClick={() => p.onDelete(row)}>删除</button>}
                      </div>
                    )}
                  </div>
                );
              })}
              {col.rows.length === 0 && !(adding && adding.parentId === col.parentId) && <div className="lc-none"><strong>暂无{p.noun}</strong></div>}
            </div>
          </section>
        ))}
        {p.manage && p.canCreate && p.trailing && (
          <section className="lc-col" aria-label={`下级${p.noun}`}>
            <header><strong>下级{p.noun}</strong><button type="button" className="link-button" onClick={() => startAdd(p.trailing!.parent.id)}>新增</button></header>
            <div className="lc-list">
              {adding && adding.parentId === p.trailing.parent.id ? addForm(`输入${p.noun}名称`) : <div className="lc-none"><strong>暂无下级{p.noun}</strong><span>可在这里新增。</span></div>}
            </div>
          </section>
        )}
      </div>
      {error && <small role="alert" className="lc-err">{error}</small>}
    </>
  );
}
