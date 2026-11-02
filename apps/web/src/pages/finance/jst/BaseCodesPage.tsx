import { useCallback, useEffect, useRef, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { CopyButton } from '../../../resources/CopyValue';
import { downloadText } from '../../../resources/csv';
import { displayValue } from '../../../resources/format';
import { ImportDialog } from '../../../resources/ImportDialog';
import { RecordDetail, useResourceCan } from '../../../resources/RecordDetail';
import { RecordForm } from '../../../resources/RecordForm';
import { resourceApi, type ListResult, type ResourceDto } from '../../../resources/api';
import { Pager } from '../common';
import { DeleteDialog, VerifyDialog } from './BaseCodeDialogs';
import { jstApi } from './jstApi';
import { BaseCodeProfileEditor } from '../../../resources/BaseCodeProfileEditor';
import { CodeCategoryDirectory } from './CodeCategoryDirectory';
import { CodeVerificationTabs } from './CodeVerificationTabs';
import { CodeSyncDialog } from './CodeSyncDialog';

const TYPE = 'finance-base-codes';
const TABS: Array<[string, string]> = [['', '全部'], ['pending', '待验证'], ['reverify', '需重新验证'], ['verified', '已验证']];

/** 复制新建：带出分类、重量等，编码、款式编码和同步状态必须重新填。 */
const NOT_COPIED = new Set(['code', 'styleCode', 'canonicalId', 'jstStatus', 'jstUploadedCode', 'verifiedSignature']);
const copyInitial = (r: Pick<ResourceDto, 'data'>) => Object.fromEntries(Object.entries(r.data).filter(([k, v]) => !NOT_COPIED.has(k) && v !== null && v !== undefined && v !== ''));

/** 商品基础编码：状态页签带数量、分类目录、批量核对验证、删除（两种方式）。增删改查沿用通用资料接口。 */
export function BaseCodesPage() {
  const def = getResourceDef(TYPE)!;
  const can = useResourceCan(TYPE);
  const { user, can: canAny } = useAuth();
  const isAdmin = !!user?.permissions.isCompanyAdmin;
  const canCost = canAny('product.cost.view');
  const [tab, setTab] = useState('pending');
  const [archiveStatus,setArchiveStatus] = useState('');
  const [cat, setCat] = useState<number | null>(null);
  const [keyword, setKeyword] = useState('');
  const [pageSize, setPageSize] = useState(30);
  const [profile, setProfile] = useState<ResourceDto | null>(null);
  const [sync, setSync] = useState<string | null>(null);
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


  const request=useRef(0);
  const reload = useCallback(async () => {
    const token=++request.current;
    try {
      const result=await resourceApi.list(TYPE, { page, pageSize, keyword: keyword.trim() || undefined, status: archiveStatus || tab || undefined, showHidden: !!archiveStatus, sortBy: sort?.by, sortDir: sort?.dir, filters: { realView: 'foldVerified', ...(cat ? {categoryId: String(cat)} : {}), ...(brand ? { brandId: brand } : {}) } });
      const overview=await jstApi.baseOverview();
      if(token!==request.current)return;
      setData(result);setOverview(overview);setError('');
    } catch (e) { if(token===request.current)setError(e instanceof ApiError ? e.message : '加载失败'); }
  }, [page, pageSize, keyword, tab, cat, sort, brand, archiveStatus]);
  useEffect(() => { const t = setTimeout(() => void reload(), 200); return () => {clearTimeout(t);request.current++;}; }, [reload]);
  useEffect(() => { resourceApi.list('finance-brands', { pageSize: 200, showHidden: true }).then((r) => setBrands(r.items.map((b) => ({ id: b.id, name: b.title })))).catch(() => setBrands([])); }, []);
  const columns = ['code','name','shortName',...(canCost ? ['cost'] : []),'weightG','categoryId'].map(key=>def.fields.find(f=>f.key===key)!);
  const verifiable = (data?.items ?? []).filter((r) => checked.includes(r.id) && ['pending', 'reverify'].includes(r.status));
  const filtered = Boolean(keyword.trim() || cat || brand);
  const clearFilters = () => { setKeyword(''); setCat(null); setBrand(''); setPage(1); };
  const isAlias = (r: ResourceDto) => typeof r.data.canonicalId === 'number';

  return (
    <div className="finance-code-page">
      <div className="page-head code-page-title">
        <div><h1>商品基础编码</h1><p>维护企业内部标准商品编码及商品组成，对标聚水潭普通商品资料</p></div>

      </div>
      <CodeVerificationTabs value={tab} counts={overview?.status ?? {}} onChange={status=>{setTab(status);setArchiveStatus('');setPage(1);setChecked([]);}} />
      <div className="jst-layout">
        <CodeCategoryDirectory type="finance-base-codes" status={archiveStatus || tab} value={cat ? String(cat) : ''} onPick={id=>{setCat(id ? Number(id) : null);setPage(1);}} reloadKey={overview} onChanged={()=>void reload()} />
        <section className="card code-list-panel">
          <header className="code-list-heading"><h2>商品编码列表</h2>          <details className="code-extra-actions"><summary>更多操作</summary>        <div className="pill-row">
          {canAny('finance.jst-sync.view') && <button type="button" className="secondary-button" onClick={() => setSync('')}>聚水潭同步维护</button>}

          {can('delete') && <button type="button" className="secondary-button" disabled={checked.length === 0} onClick={() => setDeleteMode('pending')}>删除未验证的（{checked.length}）</button>}
          {can('delete') && <button type="button" className="secondary-button" onClick={() => setDeleteMode('source')}>处理来源已删除的</button>}
          {can('import') && <button type="button" className="secondary-button" onClick={() => setImporting(true)}>导入</button>}
          {can('export') && <button type="button" className="secondary-button" onClick={async () => { try { const o = await resourceApi.export(TYPE, false); downloadText(o.filename, o.csv); } catch (e) { setError(e instanceof ApiError ? e.message : '导出失败'); } }}>导出</button>}
          {can('create') && <button type="button" className="primary-button" onClick={() => setCreating({})}>＋ 新增</button>}
        </div></details></header>
          <div className="toolbar"><input className="grow" aria-label="搜索" placeholder="搜索商品编码或商品名称" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
            <select aria-label="品牌" value={brand} onChange={(e) => { setBrand(e.target.value); setPage(1); }}>
              <option value="">全部品牌</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select><select aria-label="基础编码状态" value={archiveStatus} onChange={e=>{setArchiveStatus(e.target.value);setPage(1);setChecked([]);}}><option value="">全部状态</option><option value="disabled">停用</option><option value="deleted">来源已删除</option></select><button type="button" className="secondary-button" onClick={()=>{setPage(1);void reload();}}>查询</button></div>
          <div className="code-selection-bar"><span>已选 {checked.length} 条</span>          {can('edit') && <button type="button" className="primary-button" disabled={verifiable.length === 0} onClick={() => setVerifyIds(verifiable.map((r) => r.id))}>批量验证{verifiable.length ? `（${verifiable.length}）` : ''}</button>}</div>

          {error && <div role="alert" className="notice error">{error}</div>}
          <div className="table-scroll">
            <table className="data-table cards-narrow">
              <thead><tr>
                <th style={{ width: 32 }}><input type="checkbox" aria-label="本页全选" checked={!!data?.items.length && data.items.every((r) => checked.includes(r.id))} onChange={(e) => setChecked(e.target.checked ? [...new Set([...checked, ...(data?.items.map((r) => r.id) ?? [])])] : checked.filter((id) => !data?.items.some((r) => r.id === id)))} /></th>
                {columns.map((f) => ['code', 'weightG'].includes(f.key)
                  ? <th key={f.key} aria-sort={sort?.by === f.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}><button type="button" className="link-button" onClick={() => { setSort(sort?.by === f.key ? (sort.dir === 'asc' ? { by: f.key, dir: 'desc' } : null) : { by: f.key, dir: 'asc' }); setPage(1); }}>{f.key === 'code' ? '商品编码' : f.key === 'weightG' ? '重量' : f.label}{sort?.by === f.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>
                  : <th key={f.key}>{f.key === 'cost' ? '成本价（含运费、装卸费）' : f.key === 'shortName' ? '商品简称' : f.key === 'name' ? '商品名称' : f.label}</th>)}<th>操作</th>
              </tr></thead>
              <tbody>
                {data?.items.map((row) => {
                  return (
                    <tr key={row.id} className={row.id === selected ? 'selected' : undefined} onClick={() => setSelected(row.id)}>
                      <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`勾选 ${row.title}`} checked={checked.includes(row.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, row.id] : checked.filter((id) => id !== row.id))} /></td>
                      {columns.map((f) => <td key={f.key} data-label={f.label} className={f.type === 'money' ? 'num' : undefined}>{displayValue(f, row)}{f.key === 'code' && isAlias(row) ? <span className="pill warn">马甲</span> : null}{f.key === 'code' || f.key === 'styleCode' ? <CopyButton value={String(row.data[f.key] ?? '')} label={f.label} /> : null}</td>)}
                      <td className="row-actions" onClick={(e) => e.stopPropagation()}><button type="button" className="link-button" onClick={() => setSelected(row.id)}>查看</button>{can('edit') && <button type="button" className="link-button" onClick={() => setProfile(row)}>编辑</button>}{canAny('finance.jst-sync.view') && <button type="button" className="link-button" onClick={() => setSync(String(row.data.code ?? ''))}>同步</button>}{can('edit') && ['pending', 'reverify'].includes(row.status) && <button type="button" className="secondary-button small" onClick={() => setVerifyIds([row.id])}>核对</button>}{can('create') && <button type="button" className="link-button" onClick={() => setCreating({ initial: copyInitial(row) })}>复制新建</button>}</td>
                    </tr>
                  );
                })}
                {data && data.items.length === 0 && <tr><td colSpan={columns.length + 2} className="muted center">没有匹配的基础编码{filtered && <> <button type="button" className="link-button" onClick={clearFilters}>清除搜索和分类</button></>}</td></tr>}
                {!data && !error && <tr><td colSpan={columns.length + 2} className="muted center">加载中…</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card-foot between"><label>每页<select aria-label="每页条数" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); setChecked([]); }}>{[30,50,100].map(n => <option key={n} value={n}>{n}</option>)}</select></label><Pager page={page} total={data?.total ?? 0} pageSize={pageSize} onPage={setPage} /></div>
        </section>
      </div>
      {selected !== null && <RecordDetail def={def} id={selected} onClose={() => setSelected(null)} onChanged={() => void reload()} onCopy={values => setCreating({ initial: copyInitial({ data: values }) })} />}
      {profile && <BaseCodeProfileEditor record={profile} onClose={() => setProfile(null)} onSaved={() => { setProfile(null); void reload(); }} />}
      {sync !== null && <CodeSyncDialog type={TYPE} code={sync} onClose={() => setSync(null)} onChanged={() => void reload()} />}
      {creating && <RecordForm def={def} record={null} initial={creating.initial} onClose={() => setCreating(null)} onSaved={(dto) => { setCreating(null); setSelected(dto.id); void reload(); }} />}
      {importing && <ImportDialog def={def} onClose={() => setImporting(false)} onDone={() => { setImporting(false); void reload(); }} />}
      {verifyIds && <VerifyDialog ids={verifyIds} isAdmin={isAdmin} onClose={() => setVerifyIds(null)} onDone={() => { setChecked([]); void reload(); }} />}
      {deleteMode && <DeleteDialog mode={deleteMode} ids={deleteMode === 'pending' ? checked : undefined} onClose={() => setDeleteMode(null)} onDone={() => { setChecked([]); void reload(); }} />}
    </div>
  );
}
