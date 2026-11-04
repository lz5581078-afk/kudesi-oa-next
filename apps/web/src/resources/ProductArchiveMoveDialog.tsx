import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useCostIdentityKey } from '../pages/finance/CostIdentityBoundary';
import { resourceApi, type CategoryTreeResult } from './api';
import { productReferenceNoun } from './productReferenceList';
import './productArchiveMoveDialog.css';

export interface ProductArchiveMoveDialogProps {
  family: string; count: number; initialCategoryId?: number;
  onClose: () => void; onConfirm: (id: number) => Promise<unknown>;
}
type Category = CategoryTreeResult['nodes'][number];
function categoryPath(node: Category, nodes: ReadonlyMap<number, Category>): string | null {
  const names: string[] = [], seen = new Set<number>();
  let current: Category | undefined = node;
  while (current) {
    if (seen.has(current.id)) return null;
    seen.add(current.id); names.unshift(current.title);
    if (!current.parentId) return names.join(' / ');
    current = nodes.get(current.parentId);
  }
  return null;
}

/** Identity changes cancel the collector; the caller alone owns the canonical batch mutation. */
export function ProductArchiveMoveDialog(props: ProductArchiveMoveDialogProps) {
  const identity = useCostIdentityKey(), scope = JSON.stringify([identity, props.family]);
  const initialScope = useRef(scope), cancelled = useRef(false);
  const current = scope === initialScope.current;
  useEffect(() => { if (!current && !cancelled.current) { cancelled.current = true; props.onClose(); } }, [current, props.onClose]);
  return current ? <MoveCollector key={`${props.family}:${props.initialCategoryId ?? ''}`} {...props} /> : null;
}
function MoveCollector({ family, count, initialCategoryId, onClose, onConfirm }: ProductArchiveMoveDialogProps) {
  const noun = productReferenceNoun(family), heading = useId();
  const [nodes, setNodes] = useState<Category[]>([]), [selected, setSelected] = useState(initialCategoryId ? String(initialCategoryId) : '');
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const mounted = useRef(false), request = useRef(0), working = useRef(false), close = useRef(onClose); close.current = onClose;
  async function load() {
    const ticket = ++request.current; setLoading(true); setLoadError('');
    try {
      const tree = await resourceApi.categoryTree('finance-products', { field: 'categoryId', tab: family, showHidden: true });
      if (!mounted.current || ticket !== request.current) return;
      setNodes(tree.nodes);
      if (!tree.nodes.some(node => node.status !== 'deleted')) setLoadError('没有可移动的分类，请维护分类后重试。');
    } catch (failure) { if (mounted.current && ticket === request.current) setLoadError(failure instanceof Error ? failure.message || '分类目录读取失败，请重试。' : '分类目录读取失败，请重试。'); }
    finally { if (mounted.current && ticket === request.current) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current++; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = new Map(nodes.map(node => [node.id, node]));
  const options = nodes.filter(node => node.status !== 'deleted').map(node => ({ node, path: categoryPath(node, byId) }));
  const target = options.find(option => String(option.node.id) === selected);
  const leaf = !!target?.path && !options.some(option => option.node.parentId === target.node.id);
  const canConfirm = count > 0 && !busy && !loading && !loadError && leaf;
  function requestClose() { if (!working.current) close.current(); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (working.current || !canConfirm || !target) return;
    working.current = true; setBusy(true); setError('');
    try { await onConfirm(target.node.id); if (mounted.current) close.current(); }
    catch (failure) { if (mounted.current) { setError(failure instanceof Error ? failure.message || '移动失败，请重试。' : '移动失败，请重试。'); setBusy(false); working.current = false; } }
  }
  return createPortal(<div className="product-archive-move-backdrop"><form className="product-archive-move-dialog" role="dialog" aria-modal="true" aria-labelledby={heading} onSubmit={submit}>
    <header><div><h2 id={heading}>移动{noun}分类</h2><p>已选择 {count} 个{noun}，只能移动到最下一级分类。</p></div><button type="button" disabled={busy} onClick={requestClose}>关闭</button></header>
    {loading && <p className="product-archive-move-feedback" role="status">正在加载分类...</p>}
    {loadError && <p className="product-archive-move-feedback error" role="alert">{loadError} <button type="button" disabled={loading || busy} onClick={() => void load()}>重试</button></p>}
    <label className="product-archive-move-field"><span>目标分类</span><select aria-label="目标分类" value={selected} disabled={busy || loading} onChange={event => { setSelected(event.target.value); setError(''); }}><option value="">请选择目标分类</option>{options.map(({ node, path }) => <option key={node.id} value={node.id} disabled={!path}>{path ?? `${node.title}（分类层级不完整）`}</option>)}</select></label>
    {!loading && !loadError && selected && !target && <p className="product-archive-move-feedback error" role="alert">原目标分类已不存在或已删除，请重新选择。</p>}
    {!loading && !loadError && options.some(option => !option.path) && <p className="product-archive-move-feedback error" role="alert">部分分类层级不完整，不能作为目标，请刷新目录。</p>}
    {error && <p className="product-archive-move-feedback error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={requestClose}>取消</button><button type="submit" className="product-archive-move-confirm" disabled={!canConfirm}>确认移动</button></footer>
  </form></div>, document.body);
}
