import {BaseCodeDeletionHistory} from './BaseCodeDeletionHistory';
import {BaseCodeCreateDialog} from './BaseCodeCreateDialog';
import { Search, ClipboardCheck, Eye, Pencil,Trash2,History,Plus,RefreshCw,CheckCircle2,Clock3,AlertCircle } from 'lucide-react';
import { FinanceCodeDirectory, type CatNode } from './FinanceCodeDirectory';
import { CodeInactiveRecordsDialog } from './CodeInactiveRecordsDialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getResourceDef,LOGISTICS_CENT_SCALE,validUnitCents, unitYuanText } from '@kudesi/shared';
import { api,ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { downloadText } from '../../../resources/csv';
import { displayValue } from '../../../resources/format';
import { ImportDialog } from '../../../resources/ImportDialog';
import { RecordDetail, useResourceCan } from '../../../resources/RecordDetail';
import { RecordForm } from '../../../resources/RecordForm';
import { resourceApi, type ListResult, type ResourceDto } from '../../../resources/api';
import { FinanceCodePagination } from './FinanceCodePagination';
import { DeleteDialog, VerifyDialog } from './BaseCodeDialogs';
import { jstApi } from './jstApi';
import { BaseCodeProfileEditor } from '../../../resources/BaseCodeProfileEditor';
import './baseCodeReference.css';
import './baseCodeListParity.css';
import { CodeVerificationTabs } from './CodeVerificationTabs';
import { FinanceCategoryManager } from '../../../resources/FinanceCategoryManager';
import { CodeSyncDialog } from './CodeSyncDialog';

const TYPE = 'finance-base-codes';

async function codeCatalog(type: string, alive: () => boolean) {
  const rows: ResourceDto[] = [], seen=new Set<number>();let total:number|null=null;
  for (let page = 1; alive(); page++) {
    const result = await resourceApi.list(type, { page, pageSize: 200, showHidden:true, ...(type==='finance-code-dictionaries'?{filters:{kind:'product_category'}}:{}) });
    if (!alive()) return [];
    if(!Number.isSafeInteger(result.total)||result.total<0||total!==null&&result.total!==total)throw new Error('目录读取不完整');
    total=result.total;
    for(const row of result.items){if(!Number.isSafeInteger(row.id)||row.id<=0||seen.has(row.id))throw new Error('目录读取不完整');seen.add(row.id);rows.push(row);}
    if(rows.length>total||!result.items.length&&rows.length<total)throw new Error('目录读取不完整');
    if(rows.length===total)break;
  }
  return rows;
}

/** 复制新建：带出分类、重量等，编码、款式编码和同步状态必须重新填。 */
const NOT_COPIED = new Set(['code', 'styleCode', 'canonicalId', 'jstStatus', 'jstUploadedCode', 'verifiedSignature', 'verificationState', 'snapshot', 'signature']);
const copyInitial = (r: Pick<ResourceDto, 'data'>) => Object.fromEntries(Object.entries(r.data).filter(([k, v]) => !NOT_COPIED.has(k) && v !== null && v !== undefined && v !== ''));

/** 商品基础编码：状态页签带数量、分类目录、批量核对验证、删除（两种方式）。增删改查沿用通用资料接口。 */
export function BaseCodesPage() {
  const { user } = useAuth();
  return <BaseCodesContent key={JSON.stringify([user?.companyId, user?.id, user?.permissions])}/>;
}
function BaseCodesContent() {
  const def = getResourceDef(TYPE)!;
  const can = useResourceCan(TYPE);
  const { user, can: canAny } = useAuth();
  const isAdmin = !!user?.permissions.isCompanyAdmin;
  const canCost = canAny('product.cost.view');
  const [tab, setTab] = useState('pending');
  const [unknownInactive,setUnknownInactive]=useState(false);
  const [cat, setCat] = useState<number | null>(null);
  const [catField,setCatField]=useState('codeDictionaryCategoryId');
  const [dictionaryCats,setDictionaryCats]=useState<CatNode[]>([]);
  const [allDictionaryCats,setAllDictionaryCats]=useState<ResourceDto[]>([]);
  const [managingCategories,setManagingCategories]=useState(false);
  const [catalogRevision,setCatalogRevision]=useState(0);
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState({ keyword: '', brand: '', enabledState: '' });
  const [enabledState,setEnabledState]=useState('');
  const [pageSize, setPageSize] = useState(30);
  const [profile, setProfile] = useState<ResourceDto | null>(null);
  const [sync, setSync] = useState<string | null>(null);
  const [brand, setBrand] = useState('');
  const [brands, setBrands] = useState<Array<{ id: number; name: string }>>([]);
  const [sort, setSort] = useState<{ by: string; dir: 'asc' | 'desc' } | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [loading,setLoading]=useState(true);
  const [syncStates,setSyncStates]=useState<Record<number,{state:string;message?:string}>>({});
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [creating, setCreating] = useState<{ initial?: Record<string, unknown>; independentCategoryId?:number } | null>(null);
  const [historyOpen,setHistoryOpen]=useState(false);
  const [importing, setImporting] = useState(false);
  const [verifyIds, setVerifyIds] = useState<number[] | null>(null);
  const [deleteMode, setDeleteMode] = useState<'pending' | 'source' | null>(null);
  const [overview, setOverview] = useState<{ status: Record<string, number>; byCategory: Record<string, Record<string, number>>; byCodeCategory?:Record<string, Record<string, number>>; verification?:Record<string,number>; byCodeLifecycleCategory?:Record<string,Record<string,Record<string,number>>>; byArchiveLifecycleCategory?:Record<string,Record<string,Record<string,number>>> } | null>(null);
  const [cats, setCats] = useState<CatNode[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const catalogContext = JSON.stringify([user?.companyId, user?.id, user?.permissions]);

  const request=useRef(0);
  const reload = useCallback(async () => {
    const token=++request.current;setLoading(true);
    try {
      const result=await resourceApi.list(TYPE, { page, pageSize, keyword: query.keyword.trim() || undefined, showHidden: true, fieldKey: cat ? catField : undefined, fieldValue: cat ?? undefined, sortBy: sort?.by, sortDir: sort?.dir, filters: { realView: 'foldVerified', verificationState: tab, ...(query.enabledState?{enabledState:query.enabledState}:{}), ...(query.brand ? { brandId: query.brand } : {}) } });
      const overview=await jstApi.baseOverview();
      if(token!==request.current)return;
      setData(result);setOverview(overview);setError('');
    } catch (e) { if(token===request.current)setError(e instanceof ApiError ? e.message : '加载失败'); }finally{if(token===request.current)setLoading(false);}
  }, [page, pageSize, query, tab, cat, catField, sort]);
  useEffect(() => { const t = setTimeout(() => void reload(), 200); return () => {clearTimeout(t);request.current++;}; }, [reload]);
  const syncKey=(data?.items??[]).map(row=>`${row.id}:${row.version||row.updatedAt}`).join(','),canSyncView=canAny('finance.jst-sync.view');
  useEffect(()=>{
    setSyncStates({});if(tab!=='verified'||!canSyncView||sync!==null||loading||!syncKey)return;
    const ids=syncKey.split(',').map(part=>Number(part.split(':')[0]));let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
    const refresh=async()=>{try{
      const batches:number[][]=[];for(let i=0;i<ids.length;i+=50)batches.push(ids.slice(i,i+50));
      const results=await Promise.all(batches.map(batch=>api<{rows:Array<{id:number;state:string;message?:string}>}>(`/finance/jst-sync/items?${new URLSearchParams({type:TYPE,ids:batch.join(','),page:'1',pageSize:'50'})}`)));if(stopped)return;
      const rows=results.flatMap(result=>result.rows),byId=new Map(rows.map(row=>[row.id,row]));
      setSyncStates(Object.fromEntries(ids.map(id=>[id,byId.has(id)?{state:byId.get(id)!.state,message:byId.get(id)!.message}:{state:'unavailable'}])));
      if(rows.some(row=>['queued','confirming'].includes(row.state)))timer=setTimeout(()=>void refresh(),3000);
    }catch(error){if(!stopped){setSyncStates(Object.fromEntries(ids.map(id=>[id,{state:'error',message:error instanceof Error?error.message:'状态读取失败'}])));timer=setTimeout(()=>void refresh(),6000);}}};void refresh();return()=>{stopped=true;if(timer)clearTimeout(timer);};
  },[syncKey,tab,canSyncView,sync,loading]);
  const syncAppearance=(state:string)=>({synced:['同步成功',CheckCircle2,'success'],queued:['同步排队中',Clock3,'pending'],confirming:['等待回查确认',Clock3,'confirming'],failed:['同步失败',AlertCircle,'failed'],blocked_intent:['待处理配置/资料问题',AlertCircle,'blocked'],incomplete:['同步待补齐',AlertCircle,'blocked'],not_synced:['未同步',RefreshCw,'unsynced'],unavailable:['待刷新资料',AlertCircle,'unavailable'],error:['状态读取失败',AlertCircle,'error']} as const)[state as 'synced']??['读取同步状态…',Clock3,'loading'];
  const syncBadge=(row:ResourceDto)=>{const appearance=syncAppearance(syncStates[row.id]?.state||''),Icon=appearance[1];return <button type="button" className={`base-code-sync-badge ${appearance[2]}`} title={syncStates[row.id]?.message||appearance[0]} onClick={()=>setSync(String(row.data.code||''))}><Icon size={14}/><span>{appearance[0]}</span></button>;};
  const syncSummary=()=>{const states=(data?.items??[]).map(row=>syncStates[row.id]?.state),failed=states.includes('error'),ready=!loading&&!failed&&states.every(Boolean),count=(values:string[])=>states.filter(state=>values.includes(state)).length;return <div className="base-code-sync-counts" role="status" aria-live="polite" aria-label="本页聚水潭同步统计"><span>本页</span><span className="success"><CheckCircle2 size={15}/>同步成功 <strong>{ready?count(['synced']):'—'}</strong> 条</span><span className="failed"><AlertCircle size={15}/>同步失败 <strong>{ready?count(['failed']):'—'}</strong> 条</span>{!ready?<span>{failed?'状态读取失败':'正在读取状态…'}</span>:<>{count(['queued','confirming'])>0&&<span>同步中 {count(['queued','confirming'])} 条</span>}{count(['blocked_intent','incomplete'])>0&&<span>待补齐 {count(['blocked_intent','incomplete'])} 条</span>}{count(['not_synced'])>0&&<span>未同步 {count(['not_synced'])} 条</span>}{count(['unavailable'])>0&&<span>待刷新 {count(['unavailable'])} 条</span>}</>}</div>;};
  useEffect(() => {
    let alive = true; setCatalogReady(false); setCatalogError(''); setCats([]); setBrands([]);
    Promise.all([codeCatalog('finance-categories', () => alive), codeCatalog('finance-brands', () => alive), codeCatalog('finance-code-dictionaries', () => alive)]).then(([categories, brands, dictionaries]) => {
      if (!alive) return;
      setCats(categories.filter(row => row.status === 'active' && row.data.archiveType !== 'bundle').map(row => ({ id: row.id, name: row.title, parentId: typeof row.data.parentId === 'number' ? row.data.parentId : null })));
      setAllDictionaryCats(dictionaries.filter(row=>row.data.kind==='product_category'));
      setDictionaryCats(dictionaries.filter(row=>row.status==='active'&&row.data.kind==='product_category').sort((a,b)=>Number(a.data.sort||0)-Number(b.data.sort||0)||a.id-b.id).map(row=>({id:row.id,name:row.title,parentId:typeof row.data.parentId==='number'?row.data.parentId:null})));
      setBrands(brands.filter(row => row.status === 'active').map(row => ({ id: row.id, name: row.title })));
      setCatalogReady(true);
    }).catch(() => { if (alive) setCatalogError('分类或品牌读取失败，不能新增商品编码；请刷新重试。'); });
    return () => { alive = false; };
  }, [catalogContext,catalogRevision]);
  const selectedCategory = catalogReady ? (catField==='codeDictionaryCategoryId'?dictionaryCats:cats).find(row => row.id === cat) : undefined;
  const canCreateHere = catField==='codeDictionaryCategoryId' && !!selectedCategory && !allDictionaryCats.some(row => Number(row.data.parentId) === selectedCategory.id);
  const chooseTab = (value: string) => {
    if (value === tab) return;
    setTab(value); setPage(1); setCat(null); setCatField('codeDictionaryCategoryId'); setKeyword(''); setBrand(''); setEnabledState(''); setQuery({ keyword: '', brand: '', enabledState: '' }); setChecked([]); setData(null);
  };

  const categoryCounts=(kind:'code'|'archive')=>{
    const lifecycle=kind==='code'?overview?.byCodeLifecycleCategory:overview?.byArchiveLifecycleCategory;
    if(lifecycle)return Object.fromEntries(Object.entries(lifecycle).map(([id,phases])=>{const states=phases[tab]??{};return[id,query.enabledState?(states[query.enabledState]??0):(states.active??0)+(states.inactive??0)];}));
    return Object.fromEntries(Object.entries((kind==='code'?overview?.byCodeCategory:overview?.byCategory)??{}).map(([id,phases])=>[id,phases[tab]??0]));
  };
  const counts=categoryCounts('archive');

  const columnKeys = ['code', 'name', 'shortName', ...(canCost ? ['cost'] : []), 'weightG', 'codeDictionaryCategoryId'];
  const labels: Record<string, string> = { code: '商品编码', name: '商品名称', shortName: '商品简称', cost: '成本价（含运费、装卸费）', weightG: '重量', codeDictionaryCategoryId: '分类' };
  const columns = columnKeys.map(key => ({ ...def.fields.find(field => field.key === key)!, label: labels[key] }));
  const shownValue = (key: string, row: ResourceDto) => {
    if(key==='codeDictionaryCategoryId')return row.refLabels.codeDictionaryCategoryId || (row.refLabels.categoryId ? `商品档案分类：${row.refLabels.categoryId}` : '未设置编码分类');
    const raw = row.data[key], known = raw != null && raw !== '' && Number.isFinite(Number(raw));
    if (key === 'weightG') return known ? String(Number(raw) / 1000) + ' kg' : '—';
    if (key === 'cost') { if (!known||!validUnitCents(Number(raw),LOGISTICS_CENT_SCALE)) return '待补齐'; const [whole, fraction = ''] = unitYuanText(Number(raw),LOGISTICS_CENT_SCALE).split('.'); return '¥' + whole + '.' + fraction.padEnd(3, '0'); }
    return displayValue(columns.find(field => field.key === key)!, row) || '—';
  };
  const verifiable = (data?.items ?? []).filter((r) => checked.includes(r.id) && ['pending', 'reverify'].includes(r.status));
  const filtered = Boolean(keyword.trim() || cat || brand);
  const clearFilters = () => { setKeyword(''); setCat(null); setBrand(''); setEnabledState(''); setQuery({ keyword: '', brand: '', enabledState: '' }); setPage(1); setChecked([]); };
  const search = () => { setQuery({ keyword, brand, enabledState }); setPage(1); setChecked([]); };
  const isAlias = (r: ResourceDto) => typeof r.data.canonicalId === 'number';

  return (
    <div className="finance-code-page base-code-reference">
      <div className="page-head">
        <div><h1>商品基础编码</h1><p className="muted">维护企业内部标准商品编码及商品组成，对标聚水潭普通商品资料</p></div>

      <CodeVerificationTabs value={tab} counts={overview?.verification ?? overview?.status ?? null} onChange={chooseTab}/></div>
      {catalogError && <p role="alert" className="notice error">{catalogError}</p>}
      <div id="base-verification-workspace" aria-busy={loading} role="tabpanel" aria-labelledby={`base-verification-tab-${tab}`} className="jst-layout">
        <div><FinanceCodeDirectory cats={dictionaryCats} counts={categoryCounts('code')} value={catField==='codeDictionaryCategoryId'?cat:null} onPick={id=>{setCat(id);setCatField('codeDictionaryCategoryId');setQuery({keyword,brand,enabledState});setPage(1);setChecked([]);}} onManage={canAny('resource.finance-code-dictionaries.edit')?()=>setManagingCategories(true):undefined}/></div>
        <section className="card">
          <div className="toolbar base-code-list-heading"><h2>{selectedCategory ? `${selectedCategory.name}商品编码` : '商品编码列表'}</h2>{can('create') && (canCreateHere ? <button type="button" className="primary-button" onClick={() => setCreating({ independentCategoryId: cat! })}><Plus size={16}/>新建商品编码</button> : <span className="muted">选择末级分类后可新增</span>)}</div>
          <div className="toolbar base-code-list-filter"><input className="grow" aria-label="搜索" placeholder="搜索商品编码或商品名称" value={keyword} onChange={(e) => setKeyword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); search(); } }} />
            <select aria-label="品牌" value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="">全部品牌</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select><select aria-label="基础编码状态" value={enabledState} onChange={e=>setEnabledState(e.target.value)}><option value="">全部状态</option><option value="active">启用</option><option value="inactive">停用</option></select><button type="button" className="secondary-button" onClick={search}><Search size={16}/>查询</button></div>
          {tab==='verified'&&canSyncView&&<div className="base-batch-verification-bar"><button type="button" className="secondary-button" onClick={()=>setSync('')}><RefreshCw size={17}/>聚水潭同步维护</button>{syncSummary()}</div>}
          {tab!=='verified'&&<div className="base-batch-verification-bar"><span>已选 {checked.length} 条</span>          {can('edit') && <button type="button" className="secondary-button" disabled={verifiable.length === 0} onClick={() => setVerifyIds(verifiable.map((r) => r.id))}><ClipboardCheck size={17}/>批量验证</button>}{can('delete')&&<button type="button" className="secondary-button" disabled={!checked.length} onClick={()=>setDeleteMode(tab==='reverify'?'source':'pending')}><Trash2 size={16}/>批量删除</button>}{tab==='reverify'&&can('delete')&&<button type="button" className="secondary-button" onClick={()=>setHistoryOpen(true)}><History size={16}/>删除/禁用记录</button>}

</div>}
          {error && <div role="alert" className="notice error">{error}</div>}
          <div className="table-scroll">
            <table className="data-table cards-narrow">
              <thead><tr>
                <th style={{ width: 32 }}><input type="checkbox" disabled={loading||tab === 'verified'||!data?.items.length} aria-label="本页全选" checked={!!data?.items.length && data.items.every((r) => checked.includes(r.id))} onChange={(e) => setChecked(e.target.checked ? [...new Set([...checked, ...(data?.items.map((r) => r.id) ?? [])])] : checked.filter((id) => !data?.items.some((r) => r.id === id)))} /></th>
                {columns.map((f) => <th key={f.key} aria-sort={sort?.by === f.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}><button type="button" className="link-button" title={sort?.by===f.key?(sort.dir==='asc'?`按${f.label}降序排列`:`恢复${f.label}默认顺序`):`按${f.label}升序排列`} onClick={() => { setSort(sort?.by === f.key ? (sort.dir === 'asc' ? { by: f.key, dir: 'desc' } : null) : { by: f.key, dir: 'asc' }); setPage(1); }}>{f.label}<i className={`base-code-sort-indicator${sort?.by===f.key?' is-active':''}`} aria-hidden="true">{sort?.by===f.key?(sort.dir==='asc'?'▲':'▼'):'↕'}</i></button></th>)}<th>操作</th>
              </tr></thead>
              <tbody>
                {data?.items.map((row) => {
                  return (
                    <tr key={row.id} className={[row.id===selected?'selected':'',isAlias(row)?'raw-finished-name-display':''].filter(Boolean).join(' ')||undefined}>
                      <td onClick={(e) => e.stopPropagation()}><input type="checkbox" disabled={loading||tab === 'verified'} aria-label={`勾选 ${row.title}`} checked={checked.includes(row.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, row.id] : checked.filter((id) => id !== row.id))} /></td>
                      {columns.map((f) => <td key={f.key} data-label={f.label} className={f.type === 'money' ? 'num' : undefined}>{f.key==='code'?<strong>{shownValue(f.key,row)}</strong>:shownValue(f.key,row)}{f.key==='code'&&row.baseCodeFacts?.canonicalId===row.id&&row.baseCodeFacts.aliasCount>0&&<small className="base-code-alias-note">真身 · 关联 {row.baseCodeFacts.aliasCount} 个马甲</small>}{f.key==='code'&&row.baseCodeFacts?.canonicalId&&row.baseCodeFacts.canonicalId!==row.id&&row.baseCodeFacts.canonicalState!=='verified'&&can('view')&&<button type="button" className="link-button base-code-canonical-action" onClick={()=>setVerifyIds([row.baseCodeFacts!.canonicalId!])}>真身待验证 · 处理真身</button>}{f.key==='name'&&row.sourceStatus==='deleted'&&<small className="base-code-source-deleted">来源已删除</small>}{f.key==='code'&&tab==='verified'&&canSyncView&&syncBadge(row)}</td>)}
                      <td className="base-code-actions-cell" onClick={(e) => e.stopPropagation()}><div className="base-code-row-actions"><button type="button" className="link-button" onClick={() => setSelected(row.id)}><Eye size={15}/>查看</button>{can('edit') && <button type="button" className="link-button" onClick={() => setProfile(row)}><Pencil size={15}/>编辑</button>}{can('view') && <button type="button" className="link-button" onClick={() => setVerifyIds([row.id])}>{tab === 'verified' ? '检查资料' : '验证'}</button>}{can('delete')&&(tab==='pending'||tab==='reverify'&&row.sourceStatus==='deleted')&&<button type="button" className="link-button danger" disabled={loading} onClick={()=>{setChecked([row.id]);setDeleteMode(tab==='reverify'?'source':'pending');}}><Trash2 size={15}/>删除</button>}{tab === 'verified' && canAny('finance.jst-sync.view') && <button type="button" className="link-button" onClick={() => setSync(String(row.data.code ?? ''))}><RefreshCw size={15}/>同步</button>}{row.baseCodeFacts&&row.baseCodeFacts.issueCount>0&&can('view')&&<button type="button" className="link-button danger" onClick={()=>setVerifyIds([row.id])}>待补齐 {row.baseCodeFacts.issueCount} 项</button>}</div></td>
                    </tr>
                  );
                })}
                {data && data.items.length === 0 && <tr><td colSpan={columns.length + 2} className="muted center">没有匹配的基础编码{filtered && <> <button type="button" className="link-button" onClick={clearFilters}>清除搜索和分类</button></>}</td></tr>}
                {!data && !error && <tr><td colSpan={columns.length + 2} className="muted center">加载中…</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card-foot code-list-pagination"><label>每页<select aria-label="每页条数" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setQuery({ keyword, brand, enabledState }); setPage(1); setChecked([]); }}>{[30,50,100].map(n => <option key={n} value={n}>{n}</option>)}</select>条</label><FinanceCodePagination page={page} total={data?.total ?? 0} pageSize={pageSize} onPage={value => { setQuery({ keyword, brand, enabledState }); setPage(value); setChecked([]); }} /></div>
        </section>
      </div>
      {historyOpen&&<BaseCodeDeletionHistory canRetry={canAny('finance.jst-sync.view')} onClose={()=>setHistoryOpen(false)}>        <details className="base-code-extra-tools"><summary>资料操作</summary><div className="pill-row">{can('delete') && <button type="button" className="secondary-button" disabled={checked.length === 0} onClick={() => setDeleteMode('pending')}>删除未验证的（{checked.length}）</button>}<button type="button" className="secondary-button" onClick={()=>setUnknownInactive(true)}>验证状态待确认的停用记录</button>
          {tab!=='verified'&&canAny('finance.jst-sync.view') && <button type="button" className="secondary-button" onClick={() => setSync('')}>聚水潭同步维护</button>}
          {can('delete') && <button type="button" className="secondary-button" onClick={() => setDeleteMode('source')}>处理来源已删除的</button>}
          {can('import') && <button type="button" className="secondary-button" onClick={() => setImporting(true)}>导入</button>}
          {can('export') && <button type="button" className="secondary-button" onClick={async () => { try { const o = await resourceApi.export(TYPE, false); downloadText(o.filename, o.csv); } catch (e) { setError(e instanceof ApiError ? e.message : '导出失败'); } }}>导出</button>}
        </div></details><details><summary>商品档案分类</summary><FinanceCodeDirectory cats={cats} counts={counts} value={catField==='categoryId'?cat:null} onPick={id=>{setCat(id);setCatField('categoryId');setQuery({keyword,brand,enabledState});setPage(1);setChecked([]);}}/></details></BaseCodeDeletionHistory>}
      {unknownInactive&&<CodeInactiveRecordsDialog type={TYPE} canEnable={can('disable')} onClose={()=>setUnknownInactive(false)} onChanged={()=>void reload()}/>}
      {selected !== null && <RecordDetail def={def} id={selected} onClose={() => setSelected(null)} onChanged={() => void reload()} onCopy={values => setCreating({ initial: copyInitial({ data: values }) })} />}
      {managingCategories&&<FinanceCategoryManager target="finance-code-dictionaries" selectedId={catField==='codeDictionaryCategoryId'?cat??undefined:undefined} maxDepth={4} presentation={{kicker:'商品基础编码 · 分类设置',description:'按一级至四级维护商品编码分类，商品编码归入最末级分类。',unit:'个商品编码',footer:'分类与来源商品档案分类分别维护；含下级分类或实际引用的分类不能删除。'}} context={{field:'kind',value:'product_category',label:'商品编码分类',text:'商品编码分类'}} counts={Object.fromEntries(Object.entries(overview?.byCodeCategory??{}).map(([id,states])=>[id,Object.values(states).reduce((sum,count)=>sum+count,0)]))} onClose={()=>setManagingCategories(false)} onChanged={()=>{setCatalogRevision(value=>value+1);void reload();}}/>}
      {profile && <BaseCodeProfileEditor record={profile} onClose={() => setProfile(null)} onSaved={() => { setProfile(null); void reload(); }} />}
      {sync !== null && <CodeSyncDialog type={TYPE} code={sync} onClose={() => setSync(null)} onChanged={() => void reload()} />}
      {creating?.independentCategoryId && <BaseCodeCreateDialog categoryId={creating.independentCategoryId} onClose={()=>setCreating(null)} onDone={()=>{setCreating(null);void reload();}}/>}
      {creating && !creating.independentCategoryId && <RecordForm def={def} record={null} initial={creating.initial} onClose={() => setCreating(null)} onSaved={(dto) => { setCreating(null); setSelected(dto.id); void reload(); }} />}
      {importing && <ImportDialog def={def} onClose={() => setImporting(false)} onDone={() => { setImporting(false); void reload(); }} />}
      {verifyIds && <VerifyDialog ids={verifyIds} isAdmin={isAdmin} readOnly={!can('edit') || tab === 'verified'} onClose={() => setVerifyIds(null)} onDone={() => { setChecked([]); void reload(); }} />}
      {deleteMode && <DeleteDialog mode={deleteMode} ids={checked.length?checked:undefined} onClose={() => setDeleteMode(null)} onDone={() => { setChecked([]); void reload(); }} />}
    </div>
  );
}
