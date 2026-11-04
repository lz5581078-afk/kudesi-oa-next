import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createChecker, getResourceDef, permissionOwner, resourcePermission, type FieldDef } from '@kudesi/shared';
import { GripVertical, Trash2, X } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { resourceApi, type ResourceDto } from './api';
import { clearRefCache } from './ResourceReferenceControls';
import { loadResourceDirectory } from './resourceDirectory';
import { ReasonDialog } from './ResourceConfirmDialog';
import './resourceDictionary.css';

export function ResourceDictionaryButton({ field, onChoose, disabled }: { field: FieldDef; onChoose: (id: number) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!field.ref || !field.refOptions?.manageLabel || !getResourceDef(field.ref)?.dictionary) return null;
  return <><button type="button" className="link-button rf-manage" disabled={disabled} onClick={event => { event.preventDefault(); event.stopPropagation(); setOpen(true); }}>{field.refOptions.manageLabel}</button>{open && createPortal(<ResourceDictionaryManager target={field.ref} onClose={() => setOpen(false)} onPick={row => { onChoose(row.id); setOpen(false); }}/>, document.body)}</>;
}

/** 由资源元数据声明的小字典：原位新增并选中、完整列表、引用保护及整表排序。 */
export function ResourceDictionaryManager({ target, onClose, onPick }: { target: string; onClose: () => void; onPick?: (row: ResourceDto) => void }) {
  const def = getResourceDef(target)!;
  const config = def.dictionary!;
  const { user } = useAuth();
  const can = (action: 'create' | 'edit' | 'delete') => !!user && createChecker(user.permissions)(resourcePermission(permissionOwner(target), action));
  const scope = JSON.stringify([user?.companyId, user?.id, user?.permissions, target]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const mounted = useRef(false), serial = useRef(0), panel = useRef<HTMLElement>(null), working = useRef(false);
  const [state, setState] = useState<{ scope: string; rows: ResourceDto[] | null; error?: string }>({ scope, rows: null });
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ResourceDto | null>(null), [dragId, setDragId] = useState<number | null>(null);
  const load = useCallback(async () => {
    const sequence = ++serial.current;
    const current = () => mounted.current && scopeRef.current === scope && sequence === serial.current;
    const rows = await loadResourceDirectory(target, current, config.sortField);
    if (rows && current()) setState({ scope, rows });
  }, [scope, target, config.sortField]);
  useEffect(() => {
    mounted.current = true; working.current = false; setState({ scope, rows: null }); setDraft(''); setBusy(false); setRemoving(null); setDragId(null);
    void load().catch(error => { if (mounted.current && scopeRef.current === scope) setState({ scope, rows: null, error: error instanceof Error ? error.message : '加载失败' }); });
    return () => { mounted.current = false; serial.current++; };
  }, [scope, load]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (panel.current?.querySelector<HTMLInputElement>('input') ?? panel.current)?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const current: { rows: ResourceDto[] | null; error?: string } = state.scope === scope ? state : { rows: null };
  const rows = current.rows;
  const report = (error: unknown) => { if (mounted.current && scopeRef.current === scope) setState(old => ({ ...(old.scope === scope ? old : { rows: null }), scope, error: error instanceof Error ? error.message : '操作失败' })); };
  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setState(old => ({ ...old, error: undefined }));
    try { await action(); } catch (error) { report(error); }
    finally { if (mounted.current && scopeRef.current === scope) { working.current = false; setBusy(false); } }
  }
  const sameScope = () => mounted.current && scopeRef.current === scope;
  async function create() {
    if (!can('create') || !draft.trim()) return;
    await run(async () => {
      const saved = await resourceApi.create(target, { [def.titleField]: draft.trim() });
      if (!sameScope()) return;
      clearRefCache(target); setDraft('');
      if (onPick) onPick(saved); else await load();
    });
  }
  async function reorder(id: number) {
    if (!can('edit') || !config.sortField || !rows || dragId === null || dragId === id) return;
    const next = rows.map(row => row.id).filter(value => value !== dragId);
    next.splice(next.indexOf(id), 0, dragId); setDragId(null);
    await run(async () => { await resourceApi.reorderCategories(target, next); if (sameScope()) { clearRefCache(target); await load(); } });
  }
  return <div className="resource-dictionary-backdrop" onClick={event => event.stopPropagation()} onMouseDown={event => { event.stopPropagation(); if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={panel} className="resource-dictionary" role="dialog" aria-modal="true" aria-label={config.title} tabIndex={-1} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) { if (removing) setRemoving(null); else onClose(); } }
      if (event.key === 'Tab') {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? [])];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><div><small>{config.sectionLabel ?? def.label}</small><h2>{config.title}</h2><p>{config.hint}</p></div><button type="button" className="icon-button" aria-label="关闭字典管理" disabled={busy} onClick={onClose}><X size={18}/></button></header>
      {current.error && <div role="alert" className="notice error">{current.error}<button type="button" className="link-button" disabled={busy} onClick={() => void run(load)}>重试</button></div>}
      {removing ? <ReasonDialog title="请确认操作" hint={`确认删除“${removing.title}”吗？`} confirmLabel="确认" danger requireReason={false} onClose={() => setRemoving(null)} onConfirm={async () => { if (!sameScope()) return; await resourceApi.remove(target, removing.id, '删除未引用字典项'); if (sameScope()) { clearRefCache(target); setRemoving(null); try { await load(); } catch (error) { report(error); } } }}/> : <>
        {can('create') && <div className="resource-dictionary-create"><label>{config.nameLabel}<input autoFocus value={draft} disabled={busy} maxLength={def.fields.find(field => field.key === def.titleField)?.maxLength} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void create(); } }}/></label><button type="button" className="primary-button" disabled={busy || !draft.trim()} onClick={() => void create()}>新增并选中</button></div>}
        <div className="resource-dictionary-list">{rows === null ? !current.error && <p>正在读取…</p> : rows.length === 0 ? <p>还没有可选项，请在上方新增。</p> : rows.map(row => {
          const count = row.data[config.referenceCountField];
          const known = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
          return <div key={row.id} draggable={!!config.sortField && can('edit') && !busy} className={dragId === row.id ? 'is-dragging' : ''} onDragStart={event => { setDragId(row.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(row.id)); }} onDragOver={event => { if (dragId !== null && !busy) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!busy) void reorder(row.id); }} onDragEnd={() => setDragId(null)}><span><strong>{row.title}</strong><small>编码 {String(row.data[config.codeField] ?? '')} · {known ? `${count} 个项目引用` : '引用数读取失败'}</small></span><div className="resource-dictionary-actions">{config.sortField && can('edit') && <span title="拖动排序"><GripVertical size={17}/></span>}{can('delete') && <button type="button" className="icon-button danger" aria-label={`删除${row.title}`} title={!known ? '引用数尚未读取' : count ? '已被项目引用，不能删除' : '删除'} disabled={busy || !known || Number(count) > 0} onClick={() => setRemoving(row)}><Trash2 size={16}/></button>}</div></div>;
        })}</div>
      </>}
      <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></footer>
    </section>
  </div>;
}
