import { useCallback, useEffect, useMemo, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { CopyButton } from '../../../resources/CopyValue';
import { downloadText } from '../../../resources/csv';
import { displayValue, statusOf } from '../../../resources/format';
import { ImportDialog } from '../../../resources/ImportDialog';
import { RecordDetail, useResourceCan } from '../../../resources/RecordDetail';
import { RecordForm } from '../../../resources/RecordForm';
import { resourceApi, type ListResult, type ResourceDto } from '../../../resources/api';
import { Pager } from '../common';
import { DeleteDialog, VerifyDialog } from './BaseCodeDialogs';
import { jstApi } from './jstApi';

const TYPE = 'finance-base-codes';
const TABS: Array<[string, string]> = [['', '全部'], ['pending', '待验证'], ['reverify', '需重新验证'], ['verified', '已验证']];

/** 复制新建：带出分类、重量等，编码、款式编码和同步状态必须重新填。 */
const NOT_COPIED = new Set(['code', 'styleCode', 'canonicalId', 'jstStatus', 'jstUploadedCode', 'verifiedSignature']);
const copyInitial = (r: ResourceDto) => Object.fromEntries(Object.entries(r.data).filter(([k, v]) => !NOT_COPIED.has(k) && v !== null && v !== undefined && v !== ''));

interface CatNode { id: number; name: string; parentId: number | null }

/** 左侧分类目录：每个分类带本分类及下级的数量，点一下只看这个分类。分类的增删改和排序在“商品分类”页签里做。 */
function CategoryDirectory({ cats, counts, value, onPick }: { cats: CatNode[]; counts: Record<number, number>; value: number | null; onPick: (id: number | null) => void }) {
  const kids = useMemo(() => {
    const m = new Map<number | null, CatNode[]>();
    for (const c of cats) m.set(c.parentId && cats.some((x) => x.id === c.parentId) ? c.parentId : null, [...(m.get(c.parentId && cats.some((x) => x.id === c.parentId) ? c.parentId : null) ?? []), c]);
    return m;
  }, [cats]);
  const total = (id: number): number => (counts[id] ?? 0) + (kids.get(id) ?? []).reduce((s, k) => s + total(k.id), 0);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const render = (parent: number | null, depth: number): JSX.Element[] =>
    (kids.get(parent) ?? []).filter((c) => total(c.id) > 0 || c.id === value).flatMap((c) => {
      const has = (kids.get(c.id) ?? []).some((k) => total(k.id) > 0);
      const expanded = open.has(c.id);
      return [
        <li key={c.id} style={{ paddingLeft: depth * 12 }}>
          {has ? <button type="button" className="link-button" aria-label={expanded ? '收起' : '展开'} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })}>{expanded ? '▾' : '▸'}</button> : <span style={{ display: 'inline-block', width: 14 }} />}
          <button type="button" className={c.id === value ? 'chip active' : 'chip'} onClick={() => onPick(c.id)}>{c.name} {total(c.id)}</button>
        </li>,
        ...(has && expanded ? render(c.id, depth + 1) : []),
      ];
    });
  const all = Object.values(counts).reduce((s, n) => s + n, 0);
  return (
    <aside className="card" aria-label="分类目录">
      <strong>分类目录</strong>
      <ul className="plain-list">
        <li><button type="button" className={value === null ? 'chip active' : 'chip'} onClick={() => onPick(null)}>全部分类 {all}</button></li>
        {render(null, 0)}
      </ul>
      <p className="muted">增加、改名、删除、调整顺序请到“商品分类”页签。</p>
    </aside>
  );
}

/** 商品基础编码：状态页签带数量、分类目录、批量核对验证、删除（两种方式）。增删改查沿用通用资料接口。 */
export function BaseCodesPage() {
  const def = getResourceDef(TYPE)!;
  const can = useResourceCan(TYPE);
  const { user, can: canAny } = useAuth();
  const isAdmin = !!user?.permissions.isCompanyAdmin;
  const canCost = canAny('product.cost.view');
  const [tab, setTab] = useState('pending');
  const [cat, setCat] = useState<number | null>(null);
  const [keyword, setKeyword] = useState('');
  const [brand, setBrand] = useState('');
  const [brands, setBrands] = useState<Array<{ id: number; name: string }>>([]);
  const [sort, setSort] = useState<{ by: string; dir: 'asc' | 'desc' } | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [creating, setCreating] = useState<{ initial?: Record<string, unknown> } | null>(null);
  const [importing, setImporting] = useState(false);
  const [verifyIds, setVerifyIds] = useState<number[] | null>(null);
  const [deleteMode, setDeleteMode] = useState<'pending' | 'source' | null>(null);
  const [overview, setOverview] = useState<{ status: Record<string, number>; byCategory: Record<string, Record<string, number>> } | null>(null);
  const [cats, setCats] = useState<CatNode[]>([]);

  const reload = useCallback(async () => {
    try {
      setData(await resourceApi.list(TYPE, { page, pageSize: 20, keyword: keyword.trim() || undefined, status: tab || undefined, fieldKey: cat ? 'categoryId' : undefined, fieldValue: cat ?? undefined, sortBy: sort?.by, sortDir: sort?.dir, filters: { realView: 'foldVerified', ...(brand ? { brandId: brand } : {}) } }));
      setOverview(await jstApi.baseOverview());
      setError('');
    } catch (e) { setError(e instanceof ApiError ? e.message : '加载失败'); }
  }, [page, keyword, tab, cat, sort, brand]);
  useEffect(() => { const t = setTimeout(() => void reload(), 200); return () => clearTimeout(t); }, [reload]);
  useEffect(() => { resourceApi.list('finance-brands', { pageSize: 200, showHidden: true }).then((r) => setBrands(r.items.map((b) => ({ id: b.id, name: b.title })))).catch(() => setBrands([])); }, []);
  useEffect(() => {
    resourceApi.list('finance-categories', { pageSize: 200, showHidden: true }).then((r) => setCats(r.items.map((c) => ({ id: c.id, name: c.title, parentId: typeof c.data.parentId === 'number' ? c.data.parentId : null })))).catch(() => setCats([]));
  }, []);

  const counts = useMemo(() => {
    const out: Record<number, number> = {};
    for (const [cid, by] of Object.entries(overview?.byCategory ?? {})) {
      const n = tab ? by[tab] ?? 0 : (by.pending ?? 0) + (by.reverify ?? 0) + (by.verified ?? 0);
      if (n) out[Number(cid)] = n;
    }
    return out;
  }, [overview, tab]);

  const columns = [def.fields.find((f) => f.key === 'code')!, def.fields.find((f) => f.key === 'styleCode')!, def.fields.find((f) => f.key === 'name')!, def.fields.find((f) => f.key === 'categoryId')!, def.fields.find((f) => f.key === 'weightG')!, ...(canCost ? [def.fields.find((f) => f.key === 'cost')!] : [])];
  const verifiable = (data?.items ?? []).filter((r) => checked.includes(r.id) && ['pending', 'reverify'].includes(r.status));
  const filtered = Boolean(keyword.trim() || cat || brand);
  const clearFilters = () => { setKeyword(''); setCat(null); setBrand(''); setPage(1); };
  const isAlias = (r: ResourceDto) => typeof r.data.canonicalId === 'number';

  return (
    <div>
      <div className="page-head">
        <h1>商品基础编码</h1>
        <div className="pill-row">
          {can('edit') && <button type="button" className="primary-button" disabled={verifiable.length === 0} onClick={() => setVerifyIds(verifiable.map((r) => r.id))}>核对并验证{verifiable.length ? `（${verifiable.length}）` : ''}</button>}
          {can('delete') && <button type="button" className="secondary-button" disabled={checked.length === 0} onClick={() => setDeleteMode('pending')}>删除未验证的（{checked.length}）</button>}
          {can('delete') && <button type="button" className="secondary-button" onClick={() => setDeleteMode('source')}>处理来源已删除的</button>}
          {can('import') && <button type="button" className="secondary-button" onClick={() => setImporting(true)}>导入</button>}
          {can('export') && <button type="button" className="secondary-button" onClick={async () => { try { const o = await resourceApi.export(TYPE, false); downloadText(o.filename, o.csv); } catch (e) { setError(e instanceof ApiError ? e.message : '导出失败'); } }}>导出</button>}
          {can('create') && <button type="button" className="primary-button" onClick={() => setCreating({})}>＋ 新增</button>}
        </div>
      </div>
      <div className="tab-group page-tabs" role="tablist" aria-label="验证状态">
        {TABS.map(([v, label]) => (
          <button key={v} type="button" role="tab" aria-selected={tab === v} className={tab === v ? 'chip active' : 'chip'} onClick={() => { setTab(v); setPage(1); setChecked([]); }}>
            {label}{overview ? ` ${v ? overview.status[v] ?? 0 : (overview.status.pending ?? 0) + (overview.status.reverify ?? 0) + (overview.status.verified ?? 0)}` : ''}
          </button>
        ))}
      </div>
      <div className="jst-layout">
        <CategoryDirectory cats={cats} counts={counts} value={cat} onPick={(id) => { setCat(id); setPage(1); }} />
        <section className="card">
          <div className="toolbar"><input className="grow" aria-label="搜索" placeholder="搜索编码、款式编码、名称" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
            <select aria-label="品牌" value={brand} onChange={(e) => { setBrand(e.target.value); setPage(1); }}>
              <option value="">品牌：全部</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></div>
          {error && <div role="alert" className="notice error">{error}</div>}
          <div className="table-scroll">
            <table className="data-table cards-narrow">
              <thead><tr>
                <th style={{ width: 32 }}><input type="checkbox" aria-label="本页全选" checked={!!data?.items.length && data.items.every((r) => checked.includes(r.id))} onChange={(e) => setChecked(e.target.checked ? [...new Set([...checked, ...(data?.items.map((r) => r.id) ?? [])])] : checked.filter((id) => !data?.items.some((r) => r.id === id)))} /></th>
                {columns.map((f) => ['code', 'weightG'].includes(f.key)
                  ? <th key={f.key} aria-sort={sort?.by === f.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}><button type="button" className="link-button" onClick={() => { setSort(sort?.by === f.key ? (sort.dir === 'asc' ? { by: f.key, dir: 'desc' } : null) : { by: f.key, dir: 'asc' }); setPage(1); }}>{f.label}{sort?.by === f.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>
                  : <th key={f.key}>{f.label}</th>)}<th>聚水潭</th><th>状态</th><th />
              </tr></thead>
              <tbody>
                {data?.items.map((row) => {
                  const st = statusOf(def, row.status);
                  return (
                    <tr key={row.id} className={row.id === selected ? 'selected' : undefined} onClick={() => setSelected(row.id)}>
                      <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`勾选 ${row.title}`} checked={checked.includes(row.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, row.id] : checked.filter((id) => id !== row.id))} /></td>
                      {columns.map((f) => <td key={f.key} data-label={f.label} className={f.type === 'money' ? 'num' : undefined}>{displayValue(f, row)}{f.key === 'code' && isAlias(row) ? <span className="pill warn">马甲</span> : null}{f.key === 'code' || f.key === 'styleCode' ? <CopyButton value={String(row.data[f.key] ?? '')} label={f.label} /> : null}</td>)}
                      <td data-label="聚水潭">{({ not_synced: '未同步', pending: '排队中', synced: '已同步', failed: '同步失败' } as Record<string, string>)[String(row.data.jstStatus ?? 'not_synced')] ?? '未同步'}</td>
                      <td data-label="状态"><span className={`pill ${st.tone === 'muted' ? 'warn' : st.tone}`}>{st.label}</span></td>
                      <td onClick={(e) => e.stopPropagation()}>{can('edit') && ['pending', 'reverify'].includes(row.status) && <button type="button" className="secondary-button small" onClick={() => setVerifyIds([row.id])}>核对</button>}{can('create') && <button type="button" className="link-button" onClick={() => setCreating({ initial: copyInitial(row) })}>复制新建</button>}</td>
                    </tr>
                  );
                })}
                {data && data.items.length === 0 && <tr><td colSpan={columns.length + 4} className="muted center">没有匹配的基础编码{filtered && <> <button type="button" className="link-button" onClick={clearFilters}>清除搜索和分类</button></>}</td></tr>}
                {!data && !error && <tr><td colSpan={columns.length + 4} className="muted center">加载中…</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card-foot between"><span>共 {data?.total ?? 0} 条 · 点击一行在右侧查看</span><Pager page={page} total={data?.total ?? 0} pageSize={20} onPage={setPage} /></div>
        </section>
      </div>
      {selected !== null && <RecordDetail def={def} id={selected} onClose={() => setSelected(null)} onChanged={() => void reload()} />}
      {creating && <RecordForm def={def} record={null} initial={creating.initial} onClose={() => setCreating(null)} onSaved={(dto) => { setCreating(null); setSelected(dto.id); void reload(); }} />}
      {importing && <ImportDialog def={def} onClose={() => setImporting(false)} onDone={() => { setImporting(false); void reload(); }} />}
      {verifyIds && <VerifyDialog ids={verifyIds} isAdmin={isAdmin} onClose={() => setVerifyIds(null)} onDone={() => { setChecked([]); void reload(); }} />}
      {deleteMode && <DeleteDialog mode={deleteMode} ids={deleteMode === 'pending' ? checked : undefined} onClose={() => setDeleteMode(null)} onDone={() => { setChecked([]); void reload(); }} />}
    </div>
  );
}
