import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ImageOff, Package, Search, Settings2 } from 'lucide-react';
import { COMPANY_PRODUCTS } from '@kudesi/shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { SkuApplicationCenter } from '../flow/SkuApplicationCenter';
import './companyProducts.css';

type Photo = { url: string; name: string };
type Attributes = { priceRestricted: boolean; tags: string[] };
type Product = Attributes & {
  id: number; name: string; code: string; category: string; specification: string;
  stock: number | null; owners: string[];
};
type Catalog = {
  items: Array<Product & { photo: Photo | null }>;
  categories: Array<{ id: number; name: string }>;
  total: number; page: number; pageSize: number;
};
type Detail = Product & { photos: Photo[]; weightG: number | null; styleCode: string; priceCents?: number | null };

const endpoint = '/workspace/company-products';
const message = (error: unknown) => error instanceof ApiError ? error.message : '读取失败，请重试。';
const inventory = (stock: number | null) => stock === null ? '暂无数据' : `${stock.toLocaleString('zh-CN')} 套`;

function useCatalogRequest<T>(path: string | null) {
  const [result, setResult] = useState<{ path: string; data?: T; error?: string }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!path) return;
    let active = true;
    api<T>(path).then(data => { if (active) setResult({ path, data }); })
      .catch(error => { if (active) setResult({ path, error: message(error) }); });
    return () => { active = false; };
  }, [path, revision]);
  return {
    data: result?.path === path ? result?.data : undefined,
    error: result?.path === path ? result?.error : undefined,
    retry: () => { setResult(undefined); setRevision(value => value + 1); },
  };
}

export function CompanyProductsPage() {
  const { user } = useAuth();
  return <CompanyProducts key={JSON.stringify([user?.companyId, user?.id, user?.permissions])} />;
}

function CompanyProducts() {
  const { user, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const productId = params.get('product') ?? '';
  const listParams = new URLSearchParams();
  for (const key of ['category', 'keyword', 'page']) {
    const value = params.get(key);
    if (value) listParams.set(key, value);
  }
  const list = useCatalogRequest<Catalog>(productId ? null : `${endpoint}?${listParams}`);
  const detail = useCatalogRequest<Detail>(/^\d+$/.test(productId) ? `${endpoint}/${productId}` : null);
  const back = `${COMPANY_PRODUCTS.path}?${listParams}`;

  function update(values: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next);
  }

  if (productId) {
    const error = /^\d+$/.test(productId) ? detail.error : '产品不存在';
    return <div className="company-products">
      <Link className="secondary-button" to={back}><ArrowLeft size={16} /> 返回公司产品</Link>
      {error ? <LoadError error={error} onRetry={detail.retry} /> : detail.data ? <>
        <ProductDetail key={productId} product={detail.data} canEdit={!!user?.permissions.isCompanyAdmin}
          canApply={can('flow.apply.view')} onApply={() => update({ apply: 'sku' })} />
        {params.get('apply') === 'sku' && can('flow.apply.view') &&
          <SkuApplicationCenter initialQuery={detail.data.name} onClose={() => update({ apply: '' })} />}
      </> : <p role="status">正在读取产品详情…</p>}
    </div>;
  }

  return <div className="company-products">
    <header className="company-products-heading"><div><h1>公司产品</h1><p className="muted">按分类查看公司产品、库存和专属归属。</p></div></header>
    <CatalogSearch key={params.get('keyword') ?? ''} keyword={params.get('keyword') ?? ''}
      onSearch={keyword => update({ keyword, page: '' })} />
    {list.error ? <LoadError error={list.error} onRetry={list.retry} /> : list.data ? <>
      <div className="company-products-filters">
        <label>产品分类 <select value={params.get('category') ?? ''} onChange={event => update({ category: event.target.value, page: '' })}>
          <option value="">全部分类</option>
          {list.data.categories.map(category => <option value={category.id} key={category.id}>{category.name}</option>)}
          <option value="0">未分类</option>
        </select></label>
        <span className="muted">共 {list.data.total} 件产品</span>
      </div>
      <div className="company-products-grid">
        {list.data.items.map(product => {
          const target = new URLSearchParams(listParams);
          target.set('product', String(product.id));
          return <Link key={product.id} className="card company-product-card" to={`?${target}`}>
            <div className="company-product-cover">
              <ProductImage photo={product.photo} />
              <span className="company-product-stock">库存 {inventory(product.stock)}</span>
            </div>
            <div className="company-product-body">
              <span className="muted">{product.category}</span>
              <h2>{product.name}</h2>
              <ProductTags product={product} />
            </div>
          </Link>;
        })}
      </div>
      {list.data.items.length === 0 && <p className="empty-state">暂无符合条件的产品</p>}
      {(list.data.total > list.data.pageSize || list.data.page > 1) && <nav className="company-products-pagination" aria-label="公司产品分页">
        <button type="button" className="secondary-button" disabled={list.data.page <= 1} onClick={() => update({ page: String(list.data!.page - 1) })}>上一页</button>
        <span>第 {list.data.page} 页</span>
        <button type="button" className="secondary-button" disabled={list.data.page * list.data.pageSize >= list.data.total} onClick={() => update({ page: String(list.data!.page + 1) })}>下一页</button>
      </nav>}
    </> : <p role="status">正在读取公司产品…</p>}
  </div>;
}

function CatalogSearch({ keyword, onSearch }: { keyword: string; onSearch: (value: string) => void }) {
  const [draft, setDraft] = useState(keyword);
  return <form className="company-products-search" onSubmit={event => { event.preventDefault(); onSearch(draft.trim()); }}>
    <input type="search" className="search-input" aria-label="搜索公司产品" placeholder="输入产品名称、编码或规格" maxLength={150} value={draft} onChange={event => setDraft(event.target.value)} />
    <button type="submit" className="secondary-button"><Search size={16} /> 搜索</button>
    {keyword && <button type="button" className="secondary-button" onClick={() => onSearch('')}>清除</button>}
  </form>;
}

function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <p className="notice error" role="alert">{error} <button type="button" onClick={onRetry}>重试</button></p>;
}

function ProductImage({ photo }: { photo: Photo | null }) {
  const [failed, setFailed] = useState<string>();
  return photo && failed !== photo.url ? <img src={photo.url} alt={photo.name} loading="lazy" onError={() => setFailed(photo.url)} />
    : <span className="company-product-placeholder"><ImageOff size={30} /> 暂无图片</span>;
}

function ProductTags({ product }: { product: Pick<Product, 'priceRestricted' | 'tags' | 'owners'> }) {
  return <div className="company-product-tags">
    {product.priceRestricted && <span className="pill warn">限价品</span>}
    {product.tags.map(tag => <span key={tag} className="pill">{tag}</span>)}
    {product.owners.length > 0 && <span className="pill success">专属人 · {product.owners.join('、')}</span>}
  </div>;
}

function ProductDetail({ product, canEdit, canApply, onApply }: { product: Detail; canEdit: boolean; canApply: boolean; onApply: () => void }) {
  const [index, setIndex] = useState(0);
  const [attributes, setAttributes] = useState<Attributes>(product);
  const [editing, setEditing] = useState(false);
  const values = [
    ['组合编码', product.code], ['款式编码', product.styleCode], ['规格', product.specification],
    ['库存', inventory(product.stock)], ['重量', product.weightG === null ? '暂无数据' : `${product.weightG.toLocaleString('zh-CN', { maximumFractionDigits: 6 })} 克`],
  ];
  if (product.priceCents !== undefined) values.push(['基本售价', product.priceCents === null ? '暂无记录' : `¥${(product.priceCents / 100).toFixed(2)}`]);
  return <article className="card company-product-detail">
    <div>
      <div className="company-product-cover">{product.photos[index] ? <a href={product.photos[index].url} target="_blank" rel="noreferrer" aria-label="打开原图"><ProductImage photo={product.photos[index]} /></a> : <ProductImage photo={null} />}</div>
      {product.photos.length > 1 && <div className="company-product-thumbnails" aria-label="产品图片">
        {product.photos.map((photo, position) => <button key={position} type="button" aria-label={`查看第 ${position + 1} 张图片`} aria-pressed={index === position} onClick={() => setIndex(position)}><ProductImage photo={photo} /></button>)}
      </div>}
    </div>
    <div className="company-product-details">
      <span className="muted">{product.category}</span>
      <h1>{product.name}</h1>
      <ProductTags product={{ ...attributes, owners: product.owners }} />
      <dl>{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}</dl>
      <div className="company-product-actions">
        {canApply && <button type="button" className="primary-button" onClick={onApply}><Package size={16} /> 申请 SKU <ArrowRight size={16} /></button>}
        {canEdit && !editing && <button type="button" className="secondary-button" onClick={() => setEditing(true)}><Settings2 size={16} /> 设置产品属性</button>}
      </div>
      {editing && <ProductAttributes id={product.id} value={attributes} onCancel={() => setEditing(false)}
        onSave={value => { setAttributes(value); setEditing(false); }} />}
    </div>
  </article>;
}

function ProductAttributes({ id, value, onCancel, onSave }: { id: number; value: Attributes; onCancel: () => void; onSave: (value: Attributes) => void }) {
  const [priceRestricted, setPriceRestricted] = useState(value.priceRestricted);
  const [input, setInput] = useState(value.tags.join('，'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const tags = [...new Set(input.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))];
    if (tags.length > 8 || tags.some(tag => tag.length > 24)) { setError('最多设置 8 个标签，每个标签最多 24 字。'); return; }
    setBusy(true);
    setError('');
    try {
      onSave(await api<Attributes>(`${endpoint}/${id}/attributes`, { method: 'PATCH', body: { priceRestricted, tags } }));
    } catch (error) {
      setError(error instanceof ApiError ? error.message : '保存失败，请重试。');
      setBusy(false);
    }
  }
  return <form className="company-product-attributes" onSubmit={save}>
    <label><input type="checkbox" checked={priceRestricted} onChange={event => setPriceRestricted(event.target.checked)} /> 限价品</label>
    <label>产品标签 <input className="search-input" value={input} maxLength={220} placeholder="多个标签用逗号分隔" onChange={event => setInput(event.target.value)} /></label>
    {error && <p role="alert" className="notice error">{error}</p>}
    <div className="company-product-actions"><button type="submit" className="primary-button" disabled={busy}>保存属性</button><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button></div>
  </form>;
}
