import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { resourceApi } from '../../resources/api';
import './referenceDocumentPicker.css';

export const ReferencePickContext = createContext(false);

/** 元（文本）→ 分；空串 → null；非法 → NaN */
export function yuanToCents(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}
export const centsToYuan = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));
export const money = (c: number | null | undefined) => (c === null || c === undefined || !Number.isFinite(c) ? '—' : `¥${(c / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`);

export const DOC_STATUS_TONE: Record<string, string> = { draft: 'muted', issued: 'warn', posted: 'ok', reversed: 'bad' };

/** 搜索式选择：输入关键字，从资料里找；用于商品、客户、费用项目等可能很多的资料。 */
export function SearchPick({ type, value, label, onChange, placeholder, fieldKey, fieldValue, ariaLabel, options }: {
  type: string; value: number | null | undefined; label?: string; onChange: (id: number | null, label: string) => void;
  placeholder?: string; fieldKey?: string; fieldValue?: string; ariaLabel?: string;
  options?: Array<{ id: number; title: string }>;
}) {
  const reference = useContext(ReferencePickContext);
  const [text, setText] = useState(label ?? '');
  const [items, setItems] = useState<Array<{ id: number; title: string; detail?: string }>>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const request = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const [keyword, setKeyword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => { setText(label ?? ''); }, [label, value]);
  useEffect(() => { request.current++; clearTimeout(timer.current); setItems([]); setOpen(false); return () => { request.current++; clearTimeout(timer.current); }; }, [type, fieldKey, fieldValue]);
  useEffect(() => {
    if (!reference || !open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [reference, open]);
  const search = (kw: string) => {
    clearTimeout(timer.current);
    const version = ++request.current;
    setLoading(true); setError('');
    if (options) { setItems(options.filter(option => option.title.toLocaleLowerCase().includes(kw.trim().toLocaleLowerCase())).slice(0,80)); setLoading(false); return; }
    timer.current = setTimeout(() => {
      resourceApi.list(type, { keyword: kw, pageSize: reference ? 80 : 15, fieldKey, fieldValue })
        .then((r) => { if (request.current === version) setItems(r.items.filter((i) => i.status !== 'inactive' && i.status !== 'deleted').map((i) => ({ id: i.id, title: reference && type === 'finance-products' ? String(i.data?.basicInfoFullName || i.title) : i.title, ...(reference && i.data?.code ? { detail: String(i.data.code) } : {}) }))); })
        .catch(() => { if (request.current === version) { setItems([]); setError('资料读取失败，请重试'); } })
        .finally(() => { if (request.current === version) setLoading(false); });
    }, 200);
  };
  const optionsKey = JSON.stringify(options);
  useEffect(() => { if (open && options) search(keyword); }, [optionsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (reference) return <div className="pick reference-document-picker" ref={root} onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); root.current?.querySelector<HTMLButtonElement>('.reference-document-picker-trigger')?.focus(); } }}>
    <button type="button" data-grid-picker className="reference-document-picker-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) { setKeyword(''); search(''); } }}><span className={!value ? 'placeholder' : ''}>{label || placeholder || '请选择资料'}</span><b aria-hidden="true">{open ? '▲' : '▼'}</b></button>
    {open && <div className="reference-document-picker-menu" data-picker-menu><input autoFocus aria-label={`搜索${ariaLabel || '资料'}`} placeholder={`搜索${placeholder || ariaLabel || '资料'}`} value={keyword} onChange={event => { setKeyword(event.target.value); search(event.target.value); }}/><ul role="listbox" className="pick-list">
      {value && <li><button type="button" role="option" aria-selected={false} onClick={() => { onChange(null,''); setOpen(false); }}>清空选择</button></li>}
      {loading ? <li role="status">正在加载资料…</li> : error ? <li role="alert">{error}<button type="button" onClick={() => search(keyword)}>重试</button></li> : !items.length ? <li className="muted">没有找到</li> : items.map(item => <li key={item.id}><button type="button" role="option" aria-selected={item.id === value} onClick={() => { onChange(item.id,item.title); setOpen(false); }}>{item.title}{item.detail ? ` · ${item.detail}` : ''}</button></li>)}
    </ul></div>}
  </div>;
  return (
    <div className="pick">
      <input
        aria-label={ariaLabel} value={text} placeholder={placeholder ?? '输入名称搜索'}
        onFocus={() => { setOpen(true); search(''); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setText(e.target.value); setOpen(true); search(e.target.value); if (value) onChange(null, ''); }}
      />
      {open && (
        <ul className="pick-list" role="listbox">
          {items.length === 0 && <li className="muted">没有找到</li>}
          {items.map((i) => (
            <li key={i.id}><button type="button" role="option" aria-selected={i.id === value} onMouseDown={(e) => e.preventDefault()} onClick={() => { setText(i.title); onChange(i.id, i.title); setOpen(false); }}>{i.title}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="row-actions">
      <span className="muted">共 {total} 条</span>
      <button type="button" className="secondary-button small" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
      <span>{page} / {pages}</span>
      <button type="button" className="secondary-button small" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</button>
    </div>
  );
}

/** 利润率（百分数，最多 6 位小数）显示：12.345678 → "12.345678%"，没设置 → "未设置" */
export const pct = (p: number | null | undefined) => (p === null || p === undefined ? '未设置' : `${Number(p.toFixed(6))}%`);
