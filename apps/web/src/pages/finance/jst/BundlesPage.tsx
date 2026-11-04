import {BundleReferenceDetail} from './BundleReferenceDetail';
import {ClipboardCheck,Plus,Search,Copy,Eye,Trash2,RefreshCw,CheckCircle2,Clock3,AlertCircle} from 'lucide-react';
import {BundleArchiveHistory} from './BundleArchiveHistory';
import { SkuApplicationCenter } from '../../flow/SkuApplicationCenter';
import { loadResourceDirectory } from '../../../resources/resourceDirectory';
import { CodeInactiveRecordsDialog } from './CodeInactiveRecordsDialog';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { getResourceDef, unitYuanText } from '@kudesi/shared';
import { api,ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { downloadText } from '../../../resources/csv';
import { displayValue } from '../../../resources/format';
import { ImportDialog } from '../../../resources/ImportDialog';
import { RecordDetail, useResourceCan } from '../../../resources/RecordDetail';
import { resourceApi, type ListResult, type ResourceDto } from '../../../resources/api';
import { FinanceCodePagination } from './FinanceCodePagination';
import { BundleProfileEditor } from '../../../resources/BundleProfileEditor';
import { FinanceCodeDirectory, type CatNode } from './FinanceCodeDirectory';
import { FinanceCategoryManager } from '../../../resources/FinanceCategoryManager';
import './baseCodeReference.css';
import { BundleManualDialog } from './BundleManualDialog';
import { BundleRegenDialog } from './BundleRegenDialog';
import { BundleVerifyDialog, GenerateDialog, NamingCenterDialog, RemoveDialog, RevisionDialog } from './BundleDialogs';
import { jstApi, type BundleSummary } from './jstApi';
import { CodeSyncDialog } from './CodeSyncDialog';
import { BundleBomDialog } from './BundleBomDialog';
import { CodeVerificationTabs } from './CodeVerificationTabs';
import './bundleReference.css';
import './bundleListParity.css';

const TYPE = 'finance-bundles';
const ROLE_OPTIONS = getResourceDef('finance-bundle-lines')?.fields.find((f) => f.key === 'role')?.options ?? [];
const roleLabel = (v: string) => ROLE_OPTIONS.find((o) => o.value === v)?.label ?? v;


/** 商品组合编码：状态页签带数量；批量生成（多平台）、命名中心、核对验证、构成修订、删除/归档。普通增删改查沿用通用资料接口。 */
export function BundlesPage() {
  const { user } = useAuth();
  return <BundlesContent key={JSON.stringify([user?.companyId, user?.id, user?.permissions])}/>;
}
function BundlesContent() {
  const def = getResourceDef(TYPE)!;
  const can = useResourceCan(TYPE);
  const { user, can: canAny } = useAuth();
  const isAdmin = !!user?.permissions.isCompanyAdmin;
  const canCost=canAny('product.cost.view'), canPrice=canAny('product.price.view');
  const [summaries,setSummaries]=useState<Record<number,BundleSummary>>({});
  const [summaryError,setSummaryError]=useState('');
  const [loading,setLoading]=useState(true);
  const [syncStates,setSyncStates]=useState<Record<number,{state:string;message?:string}>>({});
  const [sort,setSort]=useState<{key:string;dir:1|-1}|null>(null);
  const [tab, setTab] = useState('pending');
  const [unknownInactive,setUnknownInactive]=useState(false);
  const [applications,setApplications]=useState(false);
  const [keyword, setKeyword] = useState('');
  const [pageSize, setPageSize] = useState(30);
  const [query, setQuery] = useState({ keyword: '', platform: '', enabledState: '' });
  const [enabledState,setEnabledState]=useState('');
  const [categories,setCategories]=useState<CatNode[]>([]);
  const [allCategories,setAllCategories]=useState<ResourceDto[]>([]);
  const [manageCategories,setManageCategories]=useState(false);
  const [categoryRevision,setCategoryRevision]=useState(0);
  const [sync, setSync] = useState<string | null>(null);
  const [reuse,setReuse] = useState<ResourceDto | null>(null);
  const [detailTab, setDetailTab] = useState<string | undefined>();
  const [bom,setBom] = useState<ResourceDto | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [categoryCounts,setCategoryCounts]=useState<Record<number,number>>({});
  const [categoryTotalCounts,setCategoryTotalCounts]=useState<Record<number,number>>({});
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [dialog, setDialog] = useState<'generate' | 'naming' | 'import' | 'regen' | null>(null);
  const [verifyIds, setVerifyIds] = useState<number[] | null>(null);
  const [revise, setRevise] = useState<ResourceDto | null>(null);
  const [remove, setRemove] = useState<ResourceDto | null>(null);
  const [profile, setProfile] = useState<ResourceDto | null>(null);
  const [manual, setManual] = useState<ResourceDto | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [platform,setPlatform] = useState('');
  const leaf=!!categoryId&&allCategories.some(row=>String(row.id)===categoryId)&&!allCategories.some(row=>String(row.data.parentId)===categoryId);
  useEffect(()=>{let alive=true;loadResourceDirectory('finance-categories',()=>alive,'sort',{includeInactive:true}).then(rows=>{if(!alive||!rows)return;const bundle=rows.filter(row=>row.data.archiveType==='bundle');setAllCategories(bundle);setCategories(bundle.filter(row=>row.status==='active').map(row=>({id:row.id,name:row.title,parentId:Number(row.data.parentId)||null})));}).catch(()=>{if(alive)setError('分类读取失败，请刷新重试');});return()=>{alive=false;};},[categoryRevision]);
  const [platforms,setPlatforms] = useState<ResourceDto[]>([]);
  useEffect(()=>{let alive=true;loadResourceDirectory('finance-platforms',()=>alive).then(rows=>{if(alive&&rows)setPlatforms(rows);}).catch(()=>{if(alive)setError('销售平台读取失败，请刷新重试');});return()=>{alive=false;};},[]);
  const [referenceDetail,setReferenceDetail]=useState<ResourceDto|null>(null);
  const request=useRef(0);
  const reload = useCallback(async () => {
    const token=++request.current;setLoading(true);setChecked([]);
    try {
      const result=await resourceApi.list(TYPE, { page, pageSize, keyword: query.keyword.trim() || undefined, showHidden: true, filters: { verificationState:tab, ...(query.enabledState?{enabledState:query.enabledState}:{}), ...(categoryId ? {bundleCategoryId:categoryId} : {}), ...(query.platform ? {platformId:query.platform} : {}) } });
      const overview=await jstApi.bundleOverview();
      if(token!==request.current)return;
      setCategoryTotalCounts(Object.fromEntries(Object.entries(overview.byBundleLifecycleCategory??{}).map(([id,phases])=>[id,Object.values(phases).reduce((total,states)=>total+Object.values(states).reduce((sum,count)=>sum+count,0),0)])));
      setData(result);setLoading(false);setCounts(overview.verification??overview.status);setCategoryCounts(Object.fromEntries(Object.entries(overview.byBundleLifecycleCategory??{}).map(([id,phases])=>{const states=phases[tab]??{};return[id,(states.active??0)+(states.inactive??0)];})));setError('');setSummaries({});setSummaryError('');
      if(result.items.length){
        try{const summary=await jstApi.bundleSummaries(result.items.map(row=>row.id));if(token===request.current)setSummaries(Object.fromEntries(summary.rows.map(row=>[row.id,row])));}
        catch{if(token===request.current)setSummaryError('组合汇总读取失败，请重试');}
      }
    } catch (e) { if(token===request.current)setError(e instanceof ApiError ? e.message : '加载失败'); } finally{if(token===request.current)setLoading(false);}
  }, [page, pageSize, query, tab, categoryId]);
  useEffect(() => { const t = setTimeout(() => void reload(), 200); return () => {clearTimeout(t);request.current++;}; }, [reload]);

  const syncKey=(data?.items??[]).map(row=>`${row.id}:${row.version||row.updatedAt}`).join(',');
  const canSyncView=canAny('finance.jst-sync.view');
  useEffect(()=>{
    setSyncStates({});if(tab!=='verified'||!canSyncView||sync!==null||loading||!syncKey)return;
    const ids=syncKey.split(',').map(part=>Number(part.split(':')[0]));let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
    const failure=(message:string)=>Object.fromEntries(ids.map(id=>[id,{state:'error',message}]));
    const refresh=async()=>{try{
      if(ids.length>50)throw new Error('当前页超过50条，请刷新列表');
      const query=new URLSearchParams({type:TYPE,ids:ids.join(','),page:'1',pageSize:'50'});
      const result=await api<{rows:Array<{id:number;state:string}>}>(`/finance/jst-sync/items?${query}`);if(stopped)return;
      const byId=new Map(result.rows.map(row=>[row.id,row]));setSyncStates(Object.fromEntries(ids.map(id=>[id,byId.has(id)?{state:byId.get(id)!.state}:{state:'unavailable'}])));
      if(result.rows.some(row=>['queued','confirming'].includes(row.state)))timer=setTimeout(()=>void refresh(),3000);
    }catch(error){if(!stopped){setSyncStates(failure(error instanceof Error?error.message:'状态读取失败'));timer=setTimeout(()=>void refresh(),6000);}}};void refresh();return()=>{stopped=true;if(timer)clearTimeout(timer);};
  },[syncKey,tab,canSyncView,sync,loading]);
  const syncAppearance=(state:string)=>({synced:['同步成功',CheckCircle2,'success'],queued:['同步排队中',Clock3,'pending'],confirming:['等待回查确认',Clock3,'confirming'],failed:['同步失败',AlertCircle,'failed'],blocked_intent:['待处理配置/资料问题',AlertCircle,'blocked'],incomplete:['同步待补齐',AlertCircle,'blocked'],not_synced:['未同步',RefreshCw,'unsynced'],unavailable:['待刷新资料',AlertCircle,'unavailable'],error:['状态读取失败',AlertCircle,'error']} as const)[state as 'synced']??['读取同步状态…',Clock3,'loading'];
  const syncBadge=(row:ResourceDto)=>{const state=syncStates[row.id],appearance=syncAppearance(state?.state||''),Icon=appearance[1];return <button type="button" className={`bundle-list-sync-badge ${appearance[2]}`} title={state?.message||appearance[0]} onClick={()=>setSync(String(row.data.code||''))}><Icon size={14}/><span>{appearance[0]}</span></button>;};
  const syncSummary=()=>{const rows=data?.items??[],states=rows.map(row=>syncStates[row.id]?.state),readFailed=states.includes('error'),ready=!loading&&!readFailed&&states.every(Boolean),count=(values:string[])=>states.filter(state=>values.includes(state)).length;return <div className="bundle-list-sync-counts" role="status" aria-live="polite" aria-label="本页聚水潭同步统计"><span>本页</span><span className="success"><CheckCircle2 size={15}/>同步成功 <strong>{ready?count(['synced']):'—'}</strong> 条</span><span className="failed"><AlertCircle size={15}/>同步失败 <strong>{ready?count(['failed']):'—'}</strong> 条</span>{!ready?<span>{readFailed?'状态读取失败':'正在读取状态…'}</span>:<>{count(['queued','confirming'])>0&&<span>同步中 {count(['queued','confirming'])} 条</span>}{count(['blocked_intent','incomplete'])>0&&<span>待补齐 {count(['blocked_intent','incomplete'])} 条</span>}{count(['not_synced'])>0&&<span>未同步 {count(['not_synced'])} 条</span>}{count(['unavailable'])>0&&<span>待刷新 {count(['unavailable'])} 条</span>}</>}</div>;};

  const columns=[['code','组合编码'],['mainStyleCode','主款式编码'],['styleCode','款式编码'],['name','商品名称 / 简称'],['platformId','平台'],['propertiesValue','规格'],...(canCost||canPrice?[['price',canCost&&canPrice?'成本价 / 销售价':canCost?'成本价':'销售价']]:[]),['weightG','重量'],['componentCount','组成'],['packageCount','包装'],['status','状态']];
  const sortValue=(row:ResourceDto,key:string):string|number=>{
    const summary=summaries[row.id];
    if(key==='weightG'||key==='componentCount'||key==='packageCount')return summary?.[key]??-1;
    if(key==='price')return(canCost?summary?.cost:summary?.salePrice)??-1;
    if(key==='mainStyleCode')return summary?.mainStyleCode||String(row.data.mainStyleCode||'');
    if(key==='platformId')return row.refLabels.platformId||'';
    if(key==='status')return row.status==='inactive'?'停用':'启用';
    return key==='name'?`${row.data.name||''} ${row.data.shortName||''}`:String(row.data[key]||'');
  };
  const rows=[...(data?.items??[])];
  if(sort)rows.sort((a,b)=>{const av=sortValue(a,sort.key),bv=sortValue(b,sort.key);return sort.dir*(typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv),'zh-CN'));});
  const money=(value:number|null|undefined)=>{if(value==null)return '待补齐';const [whole,fraction='']=unitYuanText(value).split('.');return `¥${whole}.${fraction.padEnd(3,'0')}`;};
  const cell=(row:ResourceDto,key:string)=>{
    const summary=summaries[row.id];
    if(key==='mainStyleCode')return summary?.mainStyleCode||String(row.data.mainStyleCode||'-');
    if(key==='name')return <>{String(row.data.name||row.title)}<small>简称：{String(row.data.shortName||'—')}</small></>;
    if(key==='price')return <>{canCost&&money(summary?.cost)}{canPrice&&<small>销售 {summary?.salePrice==null?'待补齐':`¥${Number(unitYuanText(summary.salePrice)).toFixed(3)}`}</small>}</>;
    if(key==='weightG')return summary?.weightG==null?'待补齐':`${(summary.weightG/1000).toFixed(6)} kg`;
    if(key==='componentCount')return <button type="button" className="link-button" onClick={()=>setReferenceDetail(row)}><Eye size={15}/>{`查看 ${summary?.componentCount??'—'} 项`}</button>;
    if(key==='packageCount')return summary?(summary.packageCount?<><strong>{summary.packageCount} 项</strong><small title={summary.packageSummary}>{summary.packageSummary||'已维护'}</small></>:<span className="bundle-package-empty-label" title="当前BOM没有明确的包装组成；系统不会根据重量区间猜测添加包装">当前BOM无包装项</span>):'—';
    if(key==='status'){const st={tone:row.status==='inactive'?'muted':'success',label:row.status==='inactive'?'停用':'启用'};return <><span className={`pill ${st.tone==='muted'?'warn':st.tone}`}>{st.label}</span></>;}
    if(key==='code')return <><strong>{String(row.data.code||'-')}</strong>{tab==='verified'&&canAny('finance.jst-sync.view')&&syncBadge(row)}</>;
    if(key==='platformId')return row.refLabels.platformId||'-';
    if(key==='styleCode'||key==='propertiesValue')return String(row.data[key]||'-');
    const field=def.fields.find(field=>field.key===key)!;return displayValue(field,row);
  };
  const verifiable = rows.filter((r) => checked.includes(r.id));
  const category=allCategories.find(row=>String(row.id)===categoryId);
  const one = rows.find((r) => r.id === checked[0]);

  return (
    <div className="finance-code-page finance-bundle-reference">
      {applications&&<SkuApplicationCenter onClose={()=>setApplications(false)}/>}
      <div className="page-head">
        <div className="bundle-list-page-title"><div><h1>商品组合编码</h1><p>销售组合装，对标聚水潭组合装商品</p></div></div>
        <button type="button" className="secondary-button" onClick={()=>setDialog('naming')}><ClipboardCheck size={16}/>组合品编码配置中心</button>
        <button type="button" className="secondary-button" onClick={()=>setApplications(true)}><ClipboardCheck size={16}/>SKU批量申请</button>

      </div>
      <BundleArchiveHistory>        <details className="bundle-extra-tools"><summary>更多操作</summary><div className="pill-row"><label>销售平台<select aria-label="销售平台筛选" value={platform} onChange={e=>setPlatform(e.target.value)}><option value="">全部平台</option>{platforms.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label><button type="button" className="secondary-button" onClick={()=>setUnknownInactive(true)}>验证状态待确认的停用记录</button>
          {tab!=='verified'&&canAny('finance.jst-sync.view') && <button type="button" className="secondary-button" onClick={() => setSync('')}>聚水潭同步维护</button>}
          {can('edit') && <button type="button" className="secondary-button" disabled={checked.length !== 1 || one?.status === 'archived'} onClick={() => one && setRevise(one)}>修改构成</button>}
          {can('edit') && <button type="button" className="secondary-button" disabled={checked.length !== 1 || one?.status === 'archived'} onClick={() => one && setManual(one)}>改码 / 改名</button>}
          {can('delete') && <button type="button" className="secondary-button" disabled={checked.length !== 1} onClick={() => one && setRemove(one)}>删除 / 归档</button>}

          {can('edit') && <button type="button" className="secondary-button" onClick={() => setDialog('regen')}>按新规则重生成编码</button>}
          {can('import') && <button type="button" className="secondary-button" onClick={() => setDialog('import')}>导入</button>}
          {can('export') && <button type="button" className="secondary-button" onClick={async () => { try { const o = await resourceApi.export(TYPE, true); downloadText(o.filename, o.csv); } catch (e) { setError(e instanceof ApiError ? e.message : '导出失败'); } }}>导出</button>}

        </div></details></BundleArchiveHistory>
      <CodeVerificationTabs scope="bundle" value={tab} counts={counts} onChange={value=>{setTab(value);setPage(1);setChecked([]);setCategoryId('');setQuery({keyword,platform,enabledState});setData(null);setReferenceDetail(null);}}/>
      <div className="tree-layout">
      <FinanceCodeDirectory cats={categories} counts={categoryCounts} kicker="商品组合编码分类" value={Number(categoryId)||null} onPick={id=>{setCategoryId(id?String(id):'');setPage(1);setChecked([]);setQuery({keyword,platform,enabledState});}} onManage={canAny('resource.finance-categories.edit')?()=>setManageCategories(true):undefined}/>

      <section className="card" id="bundle-verification-workspace" role="tabpanel" aria-labelledby={`bundle-verification-tab-${tab}`}><div className="bundle-list-heading"><h2>{category?`${category.data.name||category.title}组合编码`:'组合编码'}（{data?.total??0}）</h2>          {can('create') && (categoryId && leaf ? <button type="button" className="primary-button" onClick={() => setDialog('generate')}><Plus size={16}/>新建组合编码</button> : <span className="bundle-list-create-hint">选择末级分类后可新增</span>)}</div>
        <form className="toolbar" onSubmit={e=>{e.preventDefault();setPage(1);setChecked([]);setQuery({keyword,platform,enabledState});}}><input className="grow" aria-label="搜索" placeholder="组合编码、主款式编码、款式编码、商品名称或简称" value={keyword} onChange={(e) => setKeyword(e.target.value)} /><select aria-label="状态筛选" value={enabledState} onChange={e=>setEnabledState(e.target.value)}><option value="">全部状态</option><option value="active">启用</option><option value="inactive">停用</option></select><button type="submit" className="secondary-button" disabled={loading}><Search size={16}/>{loading?'查询中...':'查询'}</button></form>
        {tab==='verified'&&canAny('finance.jst-sync.view')&&<div className="base-batch-verification-bar"><button type="button" className="secondary-button" onClick={()=>setSync('')}><RefreshCw size={16}/>聚水潭同步维护</button>{syncSummary()}</div>}
        {tab!=='verified'&&<div className="base-batch-verification-bar"><span>已选 {checked.length} 条</span>          {can('edit') && <button type="button" className="secondary-button" disabled={loading||checked.length===0||checked.length>50} onClick={() => setVerifyIds(verifiable.map((r) => r.id))}><ClipboardCheck size={16}/>批量验证</button>}
</div>}
        {error && <div role="alert" className="notice error">{error}</div>}{summaryError&&<div role="alert" className="notice error">{summaryError}<button type="button" onClick={()=>void reload()}>重试</button></div>}
        <div className="table-scroll"><table className="data-table">
          <thead><tr>
            {tab!=='verified'&&<th style={{ width: 32 }}><input type="checkbox" aria-label="本页全选" disabled={tab==='verified'} checked={rows.length > 0 && rows.every((r) => checked.includes(r.id))} onChange={(e) => setChecked(e.target.checked ? rows.slice(0,50).map(row=>row.id) : [])} /></th>}
            {columns.map(([key,label])=><th key={key} aria-sort={sort?.key===key?sort.dir===1?'ascending':'descending':'none'}><button type="button" className="link-button" onClick={()=>setSort(current=>current?.key===key?(current.dir===1?{key,dir:-1}:null):{key,dir:1})}>{label}</button></th>)}<th>操作</th>
          </tr></thead>
          <tbody>
            {rows.map((row) => {
              return (
                <Fragment key={row.id}>
                <tr className={row.id === selected ? 'selected' : undefined}>
                  {tab!=='verified'&&<td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`勾选 ${row.title}`} disabled={tab==='verified'} checked={checked.includes(row.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, row.id] : checked.filter((id) => id !== row.id))} /></td>}
                  {columns.map(([key,label])=><td key={key} data-label={label}>{cell(row,key)}</td>)}
                  <td className="bundle-list-actions-cell" onClick={(e) => e.stopPropagation()}><div className="bundle-list-row-actions">{can('edit') && row.status !== 'archived' && <button type="button" className="link-button" onClick={() => setProfile(row)}>修改</button>}{can('edit')&&can('create')&&row.status!=='archived'&&<button type="button" className="link-button" onClick={()=>setReuse(row)}><Copy size={13}/>跨平台复用</button>}<button type="button" className="link-button" onClick={() => setBom(row)}>BOM</button>{can('edit') && row.status !== 'archived' && <button type="button" className="link-button" onClick={() => setRevise(row)}>{typeof row.data.pendingRevisionId==='number'?'组成修改待验证':'修改组成'}</button>}{can('edit')&&<button type="button" className="link-button" onClick={() => setVerifyIds([row.id])}>{tab==='verified'?'查看验证':'验证'}{summaries[row.id]?.issueCount?`（待补齐 ${summaries[row.id].issueCount} 项）`:''}</button>}{can('delete') && <button type="button" className="link-button danger" onClick={() => setRemove(row)}><Trash2 size={13}/>删除</button>}{tab==='verified'&&canAny('finance.jst-sync.view') && <button type="button" className="link-button" onClick={() => setSync(String(row.data.code ?? ''))}>同步</button>}</div></td>
                </tr>
                </Fragment>
              );
            })}
            {data && rows.length === 0 && <tr><td colSpan={columns.length + (tab==='verified'?1:2)} className="muted center">暂无组合编码</td></tr>}
            {!data && !error && <tr><td colSpan={columns.length + (tab==='verified'?1:2)} className="muted center">加载中…</td></tr>}
          </tbody>
        </table></div>
        <div className="card-foot code-list-pagination"><label>每页<select aria-label="每页条数" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); setChecked([]); }}>{[10,20,30,50].map(n => <option key={n} value={n}>{n}</option>)}</select>条</label><FinanceCodePagination page={page} total={data?.total ?? 0} pageSize={pageSize} onPage={value=>{setPage(value);setChecked([]);setQuery({keyword,platform,enabledState});}} /></div>
      </section>
      </div>
      {manageCategories&&<FinanceCategoryManager target="finance-categories" archiveType="bundle" selectedId={Number(categoryId)||undefined} maxDepth={4} counts={categoryTotalCounts} onClose={()=>setManageCategories(false)} onChanged={()=>{setCategoryRevision(value=>value+1);void reload();}}/>}
      {unknownInactive&&<CodeInactiveRecordsDialog type={TYPE} canEnable={can('disable')} onClose={()=>setUnknownInactive(false)} onChanged={()=>void reload()}/>}
      {referenceDetail&&<BundleReferenceDetail id={referenceDetail.id} onClose={()=>setReferenceDetail(null)} onEdit={can('edit')?()=>{setProfile(referenceDetail);setReferenceDetail(null);}:undefined} onComposition={can('edit')?()=>{setRevise(referenceDetail);setReferenceDetail(null);}:undefined}/>}
      {profile && <BundleProfileEditor record={profile} onClose={() => setProfile(null)} onSaved={() => { setProfile(null); void reload(); }} />}
      {selected !== null && <RecordDetail def={def} id={selected} initialTab={detailTab} onClose={() => { setSelected(null); setDetailTab(undefined); }} onChanged={() => void reload()} />}
      {sync !== null && <CodeSyncDialog type={TYPE} code={sync} onClose={() => setSync(null)} onChanged={() => void reload()} />}
      {bom && <BundleBomDialog bundle={bom} onClose={()=>setBom(null)} onRevise={()=>{setRevise(bom);setBom(null);}}/>}
      {dialog === 'import' && <ImportDialog def={def} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void reload(); }} />}
      {reuse && <GenerateDialog sourceBundle={reuse} onClose={()=>setReuse(null)} onDone={()=>void reload()}/>}
      {dialog === 'generate' && <GenerateDialog initialCategoryId={Number(categoryId)} onClose={() => setDialog(null)} onDone={() => void reload()} />}
      {dialog === 'regen' && <BundleRegenDialog onClose={() => setDialog(null)} onDone={() => void reload()} />}
      {dialog === 'naming' && <NamingCenterDialog isAdmin={isAdmin} onClose={() => setDialog(null)} />}
      {verifyIds && <BundleVerifyDialog ids={verifyIds} isAdmin={isAdmin} onClose={() => setVerifyIds(null)} onDone={() => { setChecked([]); void reload(); }} />}
      {revise && <RevisionDialog bundle={revise} onVerify={()=>setVerifyIds([revise.id])} onApply={()=>{setRevise(null);setApplications(true);}} onClose={() => setRevise(null)} onDone={() => { setChecked([]); void reload(); }} />}
      {manual && <BundleManualDialog bundle={manual} onClose={() => setManual(null)} onDone={() => { setChecked([]); void reload(); }} />}
      {remove && <RemoveDialog bundle={remove} isAdmin={isAdmin} onClose={() => setRemove(null)} onDone={() => { setChecked([]); void reload(); }} />}
    </div>
  );
}
