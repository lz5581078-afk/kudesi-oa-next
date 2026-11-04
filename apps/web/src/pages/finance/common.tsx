import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { resourceApi } from '../../resources/api';
import {ReferenceResourcePick} from './ReferenceResourcePick';
import type {PickOption,SearchPickProps} from './referencePickOptions';
import './referenceDocumentPicker.css';

export const ReferencePickContext = createContext(false);
export {referenceProductLabel} from './referencePickOptions';
export type {PickOption} from './referencePickOptions';
/** 元（文本）→ 分；空串 → null；非法 → NaN */
export function yuanToCents(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}
export const centsToYuan = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));
export const money = (c: number | null | undefined) => (c === null || c === undefined || !Number.isFinite(c) ? '—' : `¥${(c / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`);
export const referenceMoney = (value: number | null | undefined) => typeof value === 'number' && value < 0 ? `-${money(-value)}` : money(value);

export const DOC_STATUS_TONE: Record<string, string> = { draft: 'muted', issued: 'warn', posted: 'ok', reversed: 'bad' };

/** 搜索式选择：输入关键字，从资料里找；用于商品、客户、费用项目等可能很多的资料。 */
export function SearchPick(props:SearchPickProps) {
 const reference=useContext(ReferencePickContext);
 return reference?<ReferenceResourcePick {...props}/>:<RemoteSearchPick {...props}/>;
}
function RemoteSearchPick({ type, value, label, onChange, placeholder, fieldKey, fieldValue, ariaLabel, options,excludeIds }:SearchPickProps) {
  const [text, setText] = useState(label ?? '');
  const [items, setItems] = useState<PickOption[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const request = useRef(0);
  useEffect(() => { setText(label ?? ''); }, [label, value]);
  useEffect(() => { request.current++; clearTimeout(timer.current); setItems([]); setOpen(false); return () => { request.current++; clearTimeout(timer.current); }; }, [type, fieldKey, fieldValue]);
  const search = (kw: string) => {
    clearTimeout(timer.current);
    const version = ++request.current;
    if (options) { setItems(options.filter(option => option.title.toLocaleLowerCase().includes(kw.trim().toLocaleLowerCase())).slice(0,80)); return; }
    timer.current = setTimeout(() => {
      resourceApi.list(type, { keyword: kw, pageSize: 15, fieldKey, fieldValue })
        .then((r) => { if (request.current === version) setItems(r.items.filter((i) => i.status !== 'inactive' && i.status !== 'deleted').map((i) => ({ id: i.id, data: i.data, optionLabels: i.optionLabels, title: i.title }))); })
        .catch(() => { if (request.current === version) setItems([]); });
    }, 200);
  };
  const optionsKey = JSON.stringify(options);
  useEffect(() => { if (open && options) search(''); }, [optionsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const visibleItems=items.filter(item=>!excludeIds?.includes(item.id));
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
          {visibleItems.length === 0 && <li className="muted">没有找到</li>}
          {visibleItems.map((i) => (
            <li key={i.id}><button type="button" role="option" aria-selected={i.id === value} onMouseDown={(e) => e.preventDefault()} onClick={() => { setText(i.title); onChange(i.id, i.title,i.data,i.optionLabels); setOpen(false); }}>{i.title}</button></li>
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
