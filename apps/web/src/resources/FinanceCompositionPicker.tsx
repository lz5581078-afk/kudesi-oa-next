import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, FolderTree, Search, X } from 'lucide-react';
import { pinyin } from 'pinyin-pro';
import { unitYuanText, type CompositionGroup } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from './api';
import { useAuth } from '../auth/AuthContext';
import './financeSupplierPicker.css';
import './financeCompositionPicker.css';

const scopes = {
  raw: { label: '原料', archive: 'raw' }, package: { label: '产品包装', archive: 'package' },
  oem_package: { label: 'OEM包装', archive: 'oem_package' }, labor: { label: '人工成本', archive: '' },
} as const;
type Catalog = { items: ResourceDto[]; categories: ResourceDto[]; version?: ResourceDto };

export function formatCompositionCost(cents: number): string {
  if (!Number.isFinite(cents)) return '未填写';
  const [whole, decimals = ''] = unitYuanText(cents).split('.');
  return `¥${whole}.${decimals.padEnd(3, '0')}`;
}

async function readAll(type: string, query: { tab?: string; fieldKey?: string; fieldValue?: number } = {}) {
  const rows: ResourceDto[] = [];
  for (let page = 1; ; page++) {
    const result = await resourceApi.list(type, { ...query, page, pageSize: 200 });
    rows.push(...result.items);
    if (!result.items.length || rows.length >= result.total) return rows.filter(row => row.status === 'active' && !row.archived);
  }
}

async function catalog(group: CompositionGroup): Promise<Catalog> {
  if (group !== 'labor') {
    const [items, categories] = await Promise.all([readAll('finance-products', { tab: scopes[group].archive }), readAll('finance-categories', { tab: scopes[group].archive })]);
    return { items: items.filter(row => row.data.archiveType === scopes[group].archive), categories: categories.filter(row => row.data.archiveType === scopes[group].archive) };
  }
  const day = new Date().toISOString().slice(0, 10);
  const versions = (await readAll('finance-labor-versions')).filter(row => (!row.data.effectiveFrom || String(row.data.effectiveFrom) <= day) && (!row.data.effectiveTo || String(row.data.effectiveTo) >= day));
  versions.sort((a, b) => Number(b.data.isDefault === true) - Number(a.data.isDefault === true) || String(b.data.effectiveFrom ?? '').localeCompare(String(a.data.effectiveFrom ?? '')) || b.id - a.id);
  const version = versions[0];
  if (!version) return { items: [], categories: [] };
  const filter = { fieldKey: 'versionId', fieldValue: version.id };
  const [items, categories] = await Promise.all([readAll('finance-labor-costs', filter), readAll('finance-labor-categories', filter)]);
  return { version, items: items.filter(row => row.data.versionId === version.id), categories: categories.filter(row => row.data.versionId === version.id) };
}

/** 生产组成共用的直接搜索与分类窗；只走通用资料接口，人工限定当前有效版本。 */
export function FinanceCompositionPicker({ group, value, onChange, labelNow, categoriesEnabled = true, canCost = true }: { group: CompositionGroup; value: number | null; onChange: (id: number) => void; labelNow?: string; categoriesEnabled?: boolean; canCost?: boolean }) {
  const { user } = useAuth();
  const { label } = scopes[group], labor = group === 'labor';
  const [inline, setInline] = useState(false), [modal, setModal] = useState(false), [keyword, setKeyword] = useState(''), [path, setPath] = useState<number[]>([]);
  const [data, setData] = useState<Catalog | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [historicalLabel, setHistoricalLabel] = useState('');
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), menuId = useId();
  const opened = inline || modal;
  useEffect(() => {
    if (!opened) return;
    let alive = true;
    setData(null); setError('');
    void catalog(group).then(result => { if (alive) setData(result); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : '资料读取失败'); });
    return () => { alive = false; };
  }, [opened, group, revision, user?.companyId]);
  useEffect(() => {
    let alive = true;
    setHistoricalLabel('');
    if (value && !labelNow) void Promise.resolve().then(() => resourceApi.get(labor ? 'finance-labor-costs' : 'finance-products', value)).then(row => { if (alive) setHistoricalLabel(labor ? `${row.data.workName || row.title} · ${row.data.workCode || '无编号'}` : String(row.data.basicInfoFullName || row.title)); }).catch(() => undefined);
    return () => { alive = false; };
  }, [value, labelNow, labor, user?.companyId]);
  const closeModal = () => { setModal(false); setKeyword(''); trigger.current?.focus(); };
  useEffect(() => {
    if (!modal) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeModal(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [modal]);
  const items = data?.items ?? [], categories = data?.categories ?? [];
  const byId = new Map(categories.map(row => [row.id, row]));
  const categoryPath = (id: number) => {
    const names: string[] = [], seen = new Set<number>();
    for (let row = byId.get(id); row && !seen.has(row.id); row = byId.get(Number(row.data.parentId))) { seen.add(row.id); names.unshift(row.title); }
    return names.join(' / ');
  };
  const nameOf = (row: ResourceDto) => String(labor ? row.data.workName || row.title : row.data.basicInfoFullName || row.title);
  const codeOf = (row: ResourceDto) => String(row.data[labor ? 'workCode' : 'code'] || '无编号');
  const categoryOf = (row: ResourceDto) => Number(row.data[labor ? 'archiveCategoryId' : 'categoryId'] || 0);
  const metaOf = (row: ResourceDto) => `${categoryPath(categoryOf(row)) || '未分类'}${labor ? '' : ` · ${row.data.purchaseSpec || '未维护规格'}`}`;
  const word = keyword.trim().toLocaleLowerCase();
  const matches = (row: ResourceDto) => [nameOf(row), codeOf(row), categoryPath(categoryOf(row)), row.data.name, row.refLabels.brandId, row.data.specQty, row.data.specUnit, row.data.purchaseSpec, row.refLabels.workTypeId, row.refLabels.unitId, data?.version?.data.versionCode, pinyin(String(row.data[labor ? 'workName' : 'name'] || row.title), { pattern: 'first', toneType: 'none', separator: '' })].some(text => String(text ?? '').toLocaleLowerCase().includes(word));
  const parent = path.at(-1) ?? 0;
  const children = categories.filter(row => Number(row.data.parentId || 0) === parent).sort((a, b) => Number(a.data.sortOrder ?? a.data.sort ?? 0) - Number(b.data.sortOrder ?? b.data.sort ?? 0) || a.title.localeCompare(b.title, 'zh-CN'));
  const shown = items.filter(row => word ? matches(row) : !modal || parent > 0 && categoryOf(row) === parent);
  const selected = items.find(row => row.id === value);
  const chosenLabel = (row: ResourceDto) => labor ? `${nameOf(row)} · ${codeOf(row)}` : nameOf(row);
  const choose = (row: ResourceDto) => { onChange(row.id); setInline(false); setModal(false); setKeyword(''); setHistoricalLabel(chosenLabel(row)); if (modal) trigger.current?.focus(); };
  const empty = error ? <p role="alert">{error} <button type="button" onClick={() => setRevision(v => v + 1)}>重试</button></p> : !data ? <p>正在加载…</p> : <p>{labor && !data.version ? '当前没有有效启用的人力成本版本' : !modal ? labor ? '当前启用版本没有匹配的人工成本项目' : categoriesEnabled ? '没有匹配的档案' : '没有匹配的包装档案' : word ? `没有找到匹配的${label}。` : !parent ? `从上方分类进入，或直接搜索${label}。` : `当前分类暂无直属${label}，可继续进入下级分类。`}</p>;
  const price = (row: ResourceDto) => canCost && typeof row.data[labor ? 'unitPrice' : 'purchasePrice'] === 'number' ? formatCompositionCost(Number(row.data[labor ? 'unitPrice' : 'purchasePrice'])) : '';
  const option = (row: ResourceDto, popup = false) => <><span><strong>{nameOf(row)}</strong><small>{codeOf(row)} · {popup ? metaOf(row) : labor ? row.refLabels.workTypeId || '未分类' : categoryPath(categoryOf(row)) || '未分类'}{popup && labor && price(row) ? ` · ${price(row)} / ${row.refLabels.unitId || '单位'}` : ''}</small></span>{popup ? !labor && price(row) && <b>{price(row)}</b> : labor ? price(row) && <b>{price(row)} / {row.refLabels.unitId || '单位'}</b> : <b>{String(row.data.purchaseSpec || '未维护系统规格')}</b>}{popup && row.id === value && <Check size={16} />}</>;
  return <div className="finance-composition-picker">
    <div className="finance-composition-select-line">
      <div className="finance-composition-combobox" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) { setInline(false); setKeyword(''); } }}>
        <div className="finance-composition-control"><Search size={16}/><input ref={input} role="combobox" aria-label={`搜索${label}`} aria-expanded={inline} aria-controls={menuId} autoComplete="off" value={inline ? keyword : selected ? chosenLabel(selected) : labelNow || historicalLabel || (value ? `#${value}` : '')} placeholder={labor ? '输入工作编号、名称、分类或首字母搜索' : '输入编号、名称、品牌、分类或首字母搜索'} onFocus={() => { setInline(true); setKeyword(''); }} onChange={e => { setKeyword(e.target.value); setInline(true); }} onKeyDown={e => { if (e.key === 'Enter' && inline) { e.preventDefault(); e.stopPropagation(); if (shown[0]) choose(shown[0]); } if (e.key === 'Escape' && inline) { e.preventDefault(); e.stopPropagation(); setInline(false); setKeyword(''); input.current?.blur(); } }}/><button type="button" aria-label={`展开${label}选项`} onMouseDown={e => e.preventDefault()} onClick={() => { setInline(v => !v); setKeyword(''); }}><ChevronDown size={16}/></button></div>
        {inline && <div id={menuId} role="listbox" aria-label={`${label}选项`} className="finance-composition-menu">{shown.map(row => <button type="button" role="option" aria-selected={row.id === value} key={row.id} onMouseDown={e => e.preventDefault()} onClick={() => choose(row)}>{option(row)}</button>)}{!shown.length && empty}</div>}
      </div>
      {categoriesEnabled && <button ref={trigger} type="button" className="secondary-button small" onClick={() => { setInline(false); setKeyword(''); setPath([]); setModal(true); }}><FolderTree size={16}/>按分类选择</button>}
    </div>
    {modal && createPortal(<div className="finance-supplier-backdrop" onClick={e => e.stopPropagation()} onMouseDown={e => { e.stopPropagation(); if (e.target === e.currentTarget) closeModal(); }} onKeyDown={e => e.stopPropagation()}>
      <section role="dialog" aria-modal="true" aria-label={`按分类选择${label}`} className="finance-supplier-dialog finance-composition-dialog">
        <header><div><small>{labor ? '人力成本表' : `${label}档案`}</small><h3>按分类选择{label}</h3><p>可搜索全部资料，也可从一级分类开始逐级查找。</p></div><button type="button" aria-label={`关闭${label}选择`} onClick={closeModal}><X/></button></header>
        <nav aria-label="分类路径"><button type="button" onClick={() => { setPath([]); setKeyword(''); }}>全部分类</button>{path.map((id, index) => <span key={id}><ChevronRight size={14}/><button type="button" onClick={() => { setPath(path.slice(0, index + 1)); setKeyword(''); }}>{byId.get(id)?.title || `#${id}`}</button></span>)}</nav>
        <div className="finance-supplier-body"><label className="finance-supplier-search"><Search size={18}/><input autoFocus aria-label={`搜索${label}资料`} value={keyword} onChange={e => setKeyword(e.target.value)} placeholder={`搜索${label}编号、名称、分类或首字母`}/></label>
          {!!children.length && <section><h4>下级分类</h4><div className="finance-supplier-categories">{children.map(row => <button type="button" key={row.id} onClick={() => { setPath([...path, row.id]); setKeyword(''); }}><FolderTree size={17}/><span>{row.title}</span><small>{items.filter(item => categoryOf(item) === row.id).length || ''}</small><ChevronRight size={16}/></button>)}</div></section>}
          <section><h4>{word ? `搜索结果 ${shown.length} 项` : parent ? `本级${label} ${shown.length} 项` : '请选择一级分类'}</h4><div className="finance-supplier-options">{shown.map(row => <button type="button" className={row.id === value ? 'is-selected' : ''} key={row.id} onClick={() => choose(row)}>{option(row, true)}</button>)}</div>{!shown.length && empty}</section>
        </div><footer><button type="button" className="secondary-button" disabled={!path.length} onClick={() => { setPath(path.slice(0, -1)); setKeyword(''); }}>返回上一级</button><button type="button" className="primary-button" onClick={closeModal}>关闭</button></footer>
      </section>
    </div>, document.body)}
  </div>;
}
