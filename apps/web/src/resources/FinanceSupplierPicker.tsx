import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, FolderTree, Search, X } from 'lucide-react';
import { resourceApi, type ResourceDto } from './api';
import './financeSupplierPicker.css';

async function readAll(type: string) {
  const rows: ResourceDto[] = [];
  for (let page = 1; ; page++) {
    const result = await resourceApi.list(type, { page, pageSize: 200 });
    rows.push(...result.items);
    if (rows.length >= result.total || !result.items.length) return rows.filter(row => row.status === 'active');
  }
}

/** 商品供货来源沿用旧版的独立选择窗口：逐级浏览直属供应商，搜索则跨分类查找。 */
export function FinanceSupplierPicker({ value, onChange, labelNow, inputId }: { value: unknown; onChange: (id: number) => void; labelNow?: string; inputId?: string }) {
  const [open, setOpen] = useState(false), [path, setPath] = useState<number[]>([]), [keyword, setKeyword] = useState('');
  const [data, setData] = useState<{ suppliers: ResourceDto[]; categories: ResourceDto[] } | null>(null);
  const [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let alive = true;
    setError(''); setData(null);
    Promise.all([readAll('finance-suppliers'), readAll('finance-supplier-categories')])
      .then(([suppliers, categories]) => { if (alive) setData({ suppliers, categories }); })
      .catch(() => { if (alive) setError('供应商资料读取失败，当前选择仍保留。'); });
    return () => { alive = false; };
  }, [revision]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [open]);
  const categories = data?.categories ?? [], suppliers = data?.suppliers ?? [];
  const byId = new Map(categories.map(row => [row.id, row]));
  const categoryPath = (id: number) => {
    const parts: string[] = [], seen = new Set<number>();
    for (let row = byId.get(id); row && !seen.has(row.id); row = byId.get(Number(row.data.parentId))) { seen.add(row.id); parts.unshift(row.title); }
    return parts.join(' / ');
  };
  const categoryIds = (row: ResourceDto) => Array.isArray(row.data.categoryIds) ? row.data.categoryIds.map(Number) : row.data.categoryId ? [Number(row.data.categoryId)] : [];
  const selected = suppliers.find(row => row.id === Number(value));
  const parentId = path.at(-1) ?? 0;
  const children = categories.filter(row => Number(row.data.parentId || 0) === parentId).sort((a,b) => Number(a.data.sort || 0) - Number(b.data.sort || 0) || a.title.localeCompare(b.title, 'zh-CN'));
  const word = keyword.trim().toLocaleLowerCase();
  const shown = suppliers.filter(row => word
    ? [row.title, row.data.shortName, row.data.shortCode, row.data.code, ...categoryIds(row).map(categoryPath)].some(text => String(text ?? '').toLocaleLowerCase().includes(word))
    : !parentId || categoryIds(row).includes(parentId)).sort((a,b) => a.title.localeCompare(b.title, 'zh-CN'));
  return <div className="finance-supplier-control">
    <button id={inputId} ref={trigger} type="button" className="finance-supplier-trigger" aria-label="选择供应商" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setPath([]); setKeyword(''); setOpen(true); }}><span>{selected?.title || labelNow || (value ? `#${value}` : '请选择供应商')}</span><ChevronRight size={16}/></button>
    <small>简称编号：{String(selected?.data.shortCode || selected?.data.code || '未设置')}</small>
    {open && createPortal(<div className="finance-supplier-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section className="finance-supplier-dialog" role="dialog" aria-modal="true" aria-label="选择供应商">
        <header><div><small>供应商档案</small><h3>选择供应商</h3><p>可直接搜索并选择，也可按分类逐级查找。</p></div><button type="button" aria-label="关闭供应商选择" onClick={close}><X size={20}/></button></header>
        <nav aria-label="供应商分类路径"><button type="button" onClick={() => setPath([])}>全部供应商</button>{path.map((id, index) => <span key={id}><ChevronRight size={14}/><button type="button" onClick={() => setPath(path.slice(0,index+1))}>{byId.get(id)?.title || `#${id}`}</button></span>)}</nav>
        <div className="finance-supplier-body"><label className="finance-supplier-search"><Search size={18}/><input autoFocus aria-label="搜索供应商名称、简称或编号" placeholder="搜索供应商名称、简称或编号" value={keyword} onChange={event => setKeyword(event.target.value)}/></label>
          {error ? <div role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => setRevision(v => v+1)}>重新加载</button></div> : !data ? <p role="status">正在加载供应商资料…</p> : <>
            {children.length > 0 && <section><h4>下级分类</h4><div className="finance-supplier-categories">{children.map(row => <button key={row.id} type="button" onClick={() => setPath([...path,row.id])}><FolderTree size={16}/><span>{row.title}</span><ChevronRight size={16}/></button>)}</div></section>}
            <section><h4>{word ? `搜索结果 ${shown.length} 个` : parentId ? '本级供应商' : `全部供应商 ${shown.length} 个`}</h4><div className="finance-supplier-options">{shown.map(row => <button key={row.id} type="button" className={row.id === Number(value) ? 'is-selected' : ''} onClick={() => { onChange(row.id); close(); }}><span><strong>{row.title}</strong><small>{row.data.shortName && row.data.shortName !== row.title ? `简称：${row.data.shortName}` : '未设置简称'}{row.data.shortCode || row.data.code ? ` · 编号 ${row.data.shortCode || row.data.code}` : ''}{categoryIds(row).length ? ` · ${categoryIds(row).map(categoryPath).filter(Boolean).join(' / ')}` : ''}</small></span>{row.id === Number(value) && <Check size={18}/>}</button>)}</div>{!shown.length && <p>{word ? '没有找到匹配的供应商。' : '当前分类暂无直属供应商，请继续进入下级分类或先维护供应商档案。'}</p>}</section>
          </>}
        </div><footer><button type="button" className="secondary-button" disabled={!path.length} onClick={() => setPath(path.slice(0,-1))}>返回上一级</button><button type="button" className="primary-button" onClick={close}>关闭</button></footer>
      </section>
    </div>, document.body)}
  </div>;
}
