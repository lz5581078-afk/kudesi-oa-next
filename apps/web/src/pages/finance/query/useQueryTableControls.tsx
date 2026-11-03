import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Settings } from 'lucide-react';
import type { Col } from './QueryKit';
import { ReferenceSearch, querySearchTerms } from './ReferenceSearch';

export interface QueryTableControls { storageKey: string; pageSize?: number; searchPlaceholder?: string }
/** 旧版查询列表的公共搜索、列设置、三态排序和本地分页；不另建数据接口。 */
export function useQueryTableControls<R>(allCols: Col<R>[], allRows: R[] | null, options?: QueryTableControls, caption?: string) {
  const [keyword, setKeyword] = useState(''), [page, setPage] = useState(1), [open, setOpen] = useState(false);
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [stored, setStored] = useState<{ key?: string; columns?: string[] }>({});
  const panel = useRef<HTMLDivElement>(null);
  const [sizing,setSizing]=useState<{key?:string;widths:Record<string,number>}>({widths:{}});
  const resize=useRef<{key:string;x:number;initial:number;pointer:number;next:Record<string,number>} | null>(null);
  useEffect(() => {
    if (!options) return;
    setKeyword(''); setPage(1); setSort(null); setOpen(false);
    try { const value: unknown = JSON.parse(localStorage.getItem(options.storageKey) || 'null'); setStored({ key: options.storageKey, columns: Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : undefined }); }
    catch { setStored({ key: options.storageKey }); }
  }, [options?.storageKey]);
  useEffect(()=>{
    if(!options)return;
    const widths:Record<string,number>={};
    try{const saved=JSON.parse(localStorage.getItem(`${options.storageKey}.widths`)||'{}');for(const col of allCols){const value=saved?.[col.key];if(typeof value==='number'&&Number.isFinite(value)&&value>=88&&value<=720)widths[col.key]=value;}}catch{/* 损坏的偏好恢复为自动列宽。 */}
    setSizing({key:options.storageKey,widths});resize.current=null;
  },[options?.storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  const keys = stored.key === options?.storageKey ? stored.columns : undefined;
  const visible = allCols.filter(col => !keys || keys.includes(col.key) || col.action);
  const cols = options && visible.length ? visible : allCols;
  const text = (row: R, col: Col<R>) => col.csv?.(row) ?? col.sortValue?.(row) ?? '';
  const terms = querySearchTerms(keyword).map(term=>term.toLocaleLowerCase());
  const filtered = useMemo(() => !options || !terms.length ? allRows : allRows?.filter(row => {
    const value = allCols.map(col => String(text(row, col))).join(' ').toLocaleLowerCase();
    return terms.some(term => value.includes(term));
  }) ?? null, [allRows, keyword, allCols, !!options]); // eslint-disable-line react-hooks/exhaustive-deps
  const ordered = useMemo(() => {
    const col = allCols.find(candidate => candidate.key === sort?.key);
    if (!options || !filtered || !sort || !col) return filtered;
    return filtered.map((row, index) => ({ row, index })).sort((a, b) => {
      const left = col.sortValue ? col.sortValue(a.row) : text(a.row,col), right = col.sortValue ? col.sortValue(b.row) : text(b.row,col);
      const empty=(value:unknown)=>value===null||value===undefined||typeof value==='number'&&!Number.isFinite(value)||typeof value==='string'&&(!value.trim()||value.trim()==='-');
      if(empty(left)!==empty(right))return empty(left)?1:-1;
      if(empty(left)&&empty(right))return a.index-b.index;
      const compared = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), 'zh-CN', { numeric: true, sensitivity:'base' });
      return compared * (sort.direction === 'asc' ? 1 : -1) || a.index - b.index;
    }).map(item => item.row);
  }, [filtered, allCols, sort, !!options]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPage(1), [keyword, sort, allRows?.length]);
  const size = options?.pageSize ?? 20, pages = Math.max(1, Math.ceil((ordered?.length ?? 0) / size)), current = Math.min(page, pages);
  const rows = options ? ordered?.slice((current - 1) * size, current * size) ?? null : allRows;
  const save = (next: string[]) => {
    if (!options) return;
    setStored({ key: options.storageKey, columns: next });
    try { localStorage.setItem(options.storageKey, JSON.stringify(next)); } catch { /* 存储不可用仍可在当前列表设置。 */ }
  };
  const toolbar = options && <div className="qk-reference-toolbar"><ReferenceSearch value={keyword} onChange={setKeyword} label={`${caption || '列表'}搜索`} placeholder={options.searchPlaceholder}/><span>{allRows === null ? '加载中…' : terms.length ? `筛选 ${filtered?.length ?? 0}/${allRows?.length ?? 0} 条` : `共 ${allRows?.length ?? 0} 条`}</span>{keyword && <button type="button" className="link-button" onClick={()=>setKeyword('')}>清空</button>}<div ref={panel} className="qk-reference-columns"><button type="button" className="icon-button" title="显示字段" aria-label="显示字段" aria-expanded={open} onClick={() => setOpen(value => !value)}><Settings size={15}/></button>{open && <div className="qk-reference-popover"><strong>显示列</strong>{allCols.map(col => <label key={col.key}><input type="checkbox" checked={cols.some(item => item.key === col.key)} disabled={col.action || cols.length === 1 && cols[0].key === col.key} onChange={() => save(cols.some(item => item.key === col.key) ? cols.filter(item => item.key !== col.key).map(item => item.key) : allCols.filter(item => item.key === col.key || cols.some(selected => selected.key === item.key)).map(item => item.key))}/>{col.head}</label>)}<button type="button" className="secondary-button small" onClick={() => save(allCols.map(col => col.key))}>显示全部</button><button type="button" className="secondary-button small" onClick={() => save(allCols.map(col => col.key))}>恢复默认</button></div>}</div></div>;
  const pagination = options && pages > 1 && <div className="qk-reference-pagination"><span>共 {ordered?.length ?? 0} 条 · 第 {current}/{pages} 页</span><div><button type="button" disabled={current <= 1} onClick={() => setPage(current - 1)}>上一页</button><button type="button" disabled={current >= pages} onClick={() => setPage(current + 1)}>下一页</button></div></div>;
  const toggleSort = (key: string) => setSort(value => value?.key !== key ? { key, direction: 'asc' } : value.direction === 'asc' ? { key, direction: 'desc' } : null);
  const widths=sizing.key===options?.storageKey?sizing.widths:{};
  const startResize=(key:string,event:PointerEvent<HTMLButtonElement>)=>{
    if(!options)return;event.preventDefault();event.stopPropagation();
    resize.current={key,x:event.clientX,initial:event.currentTarget.closest('th')?.getBoundingClientRect().width||widths[key]||140,pointer:event.pointerId,next:widths};
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveResize=(event:PointerEvent<HTMLButtonElement>)=>{
    const active=resize.current;if(!active||active.pointer!==event.pointerId||!options)return;
    const width=Math.round(Math.max(88,Math.min(720,active.initial+event.clientX-active.x)));
    active.next={...active.next,[active.key]:width};setSizing({key:options.storageKey,widths:active.next});
  };
  const stopResize=(event:PointerEvent<HTMLButtonElement>)=>{
    const active=resize.current;resize.current=null;if(!active||!options)return;
    try{localStorage.setItem(`${options.storageKey}.widths`,JSON.stringify(active.next));}catch{/* 当前列宽仍保留。 */}
    if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return { cols, rows, toolbar, pagination, sort, toggleSort, widths, startResize, moveResize, stopResize };
}
