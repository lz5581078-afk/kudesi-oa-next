import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { financeApi, type DebugComponents } from './financeApi';

/** 选中的筛选：整个分类（含下级），或某一个商品基础编码 */
export interface ComponentFilterValue { categoryId?: number; baseCodeId?: number; label: string }

/** 商品编码目录：左边分类树，右边该分类下的商品；挑一个分类或一个商品，用来筛出“用到了它”的组合。 */
export function PricingComponentFilter({ value, onChange, disabled }: { value: ComponentFilterValue | null; onChange: (v: ComponentFilterValue | null) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pricing-component-filter">
      <button type="button" className="secondary-button" disabled={disabled} aria-label="选择商品分类或商品" title={value?.label || '全部商品'} onClick={() => setOpen(true)}>
        📁 {value?.baseCodeId ? value.label : value?.label?.split(' / ').at(-1) || '全部商品'}
      </button>
      {value && <button type="button" className="link-button" disabled={disabled} aria-label="清空商品筛选" onClick={() => onChange(null)}>清空</button>}
      {open && <ComponentDialog value={value} onSelect={(v) => { onChange(v); setOpen(false); }} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ComponentDialog({ value, onSelect, onClose }: { value: ComponentFilterValue | null; onSelect: (v: ComponentFilterValue | null) => void; onClose: () => void }) {
  const serial = useRef(0);
  const [categoryId, setCategoryId] = useState<number | null>(value?.categoryId ?? null);
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<DebugComponents>({ categories: [], rows: [], total: 0, page: 1, pageSize: 30 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const initialized = useRef(false);

  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);

  useEffect(() => {
    const current = ++serial.current;
    setLoading(true); setError('');
    const timer = setTimeout(() => {
      financeApi.debugComponents({ categoryId: keyword.trim() ? undefined : categoryId ?? undefined, keyword: keyword.trim() || undefined, page })
        .then((r) => { if (current === serial.current) setData(r); })
        .catch((e) => { if (current === serial.current) setError(e instanceof ApiError ? e.message : '加载失败'); })
        .finally(() => { if (current === serial.current) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); serial.current++; };
  }, [categoryId, keyword, page, attempt]);

  const index = new Map(data.categories.map((c) => [c.id, c]));
  const pathFor = (id: number | null) => {
    const path: Array<{ id: number; name: string }> = [];
    const seen = new Set<number>();
    let row = id === null ? undefined : index.get(id);
    while (row && !seen.has(row.id)) { path.unshift(row); seen.add(row.id); row = row.parentId === null ? undefined : index.get(row.parentId); }
    return path;
  };
  useEffect(() => {
    if (initialized.current || !data.categories.length) return;
    initialized.current = true;
    const next = new Set(data.categories.filter((c) => c.parentId === null).map((c) => c.id));
    pathFor(categoryId).forEach((p) => next.add(p.id));
    setExpanded(next);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const term = keyword.trim().toLowerCase();
  const label = pathFor(categoryId).map((p) => p.name).join(' / ');
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const navigate = (id: number | null) => { setCategoryId(id); setKeyword(''); setPage(1); if (id !== null) setExpanded((old) => new Set([...old, ...pathFor(id).map((p) => p.id)])); };
  const matches = data.categories.filter((c) => pathFor(c.id).map((p) => p.name).join('/').toLowerCase().includes(term));

  const branch = (parent: number | null, depth: number, seen: Set<number>): JSX.Element[] =>
    data.categories.filter((c) => c.parentId === parent && !seen.has(c.id)).map((c) => {
      const hasKids = data.categories.some((k) => k.parentId === c.id), isOpen = expanded.has(c.id);
      return (
        <div key={c.id}>
          <div className={`cost-category${categoryId === c.id ? ' selected' : ''}`} style={{ paddingLeft: Math.min(depth, 5) * 14 }}>
            {hasKids
              ? <button type="button" className="cost-category-toggle" aria-label={`${isOpen ? '收起' : '展开'}${c.name}`} aria-expanded={isOpen} onClick={() => setExpanded((old) => { const next = new Set(old); if (isOpen) next.delete(c.id); else next.add(c.id); return next; })}>{isOpen ? '▾' : '▸'}</button>
              : <span className="cost-category-toggle" />}
            <button type="button" className="cost-category-select" aria-pressed={categoryId === c.id} onClick={() => navigate(c.id)}><span>{c.name}</span></button>
          </div>
          {hasKids && isOpen && branch(c.id, depth + 1, new Set([...seen, c.id]))}
        </div>
      );
    });

  return (
    <div className="modal-backdrop" role="presentation"><div className="modal card wide" role="dialog" aria-label="选择商品分类或商品">
      <div className="modal-head between"><strong>商品编码目录</strong><button type="button" className="icon-button" aria-label="关闭商品选择" onClick={onClose}>✕</button></div>
      <div className="modal-body">
        <input autoFocus type="search" aria-label="搜索商品分类、名称或编码" placeholder="搜索全部分类、商品名称或编码" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
        {error && <div role="alert" className="notice error">{error} <button type="button" className="link-button" onClick={() => setAttempt((n) => n + 1)}>重试</button></div>}
        <div className="pricing-component-columns" aria-busy={loading}>
          <section>
            <h3>{term ? '匹配分类' : '分类目录'}</h3>
            <div className="pricing-component-categories">
              <button type="button" className={`cost-category-select${categoryId === null && !term ? ' active' : ''}`} onClick={() => navigate(null)}>全部商品</button>
              {term ? matches.map((c) => <button type="button" key={c.id} className="cost-category-select" onClick={() => navigate(c.id)}>{pathFor(c.id).map((p) => p.name).join(' / ')}</button>) : branch(null, 0, new Set())}
              {term && matches.length === 0 && <p className="muted">没有匹配分类</p>}
            </div>
          </section>
          <section>
            <h3>{term ? '全部搜索结果' : label || '全部商品'} <small className="muted">{loading ? '加载中…' : `${data.total} 项`}</small></h3>
            <div className="pricing-component-products">
              {!loading && !error && data.rows.map((r) => (
                <button type="button" key={r.id} className={`cost-category-select${value?.baseCodeId === r.id ? ' active' : ''}`} onClick={() => onSelect({ baseCodeId: r.id, categoryId: r.categoryId ?? undefined, label: r.name })}>
                  <span><strong>{r.name}</strong> <small>{r.code}</small></span>
                  <small>{pathFor(r.categoryId).map((p) => p.name).join(' / ')}</small>
                </button>
              ))}
              {loading ? <p className="muted" role="status">正在查找商品…</p> : !error && data.rows.length === 0 && <p className="muted">没有匹配商品</p>}
            </div>
            <div className="row-actions"><span className="muted">{page}/{pages} 页</span>
              <button type="button" className="secondary-button small" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
              <button type="button" className="secondary-button small" disabled={loading || page >= pages} onClick={() => setPage(page + 1)}>下一页</button></div>
          </section>
        </div>
      </div>
      <div className="modal-foot">
        <span className="muted">{term ? '搜索全部商品' : label || '全部商品'}</span>
        {!term && <button type="button" className="primary-button" disabled={loading || Boolean(error) || (categoryId !== null && !index.has(categoryId))}
          onClick={() => onSelect(categoryId !== null ? { categoryId, label } : null)}>{categoryId !== null ? '选择此分类' : '选择全部商品'}</button>}
      </div>
    </div></div>
  );
}
