import { SkuApplicationCenter } from '../../flow/SkuApplicationCenter';
import { loadResourceDirectory } from '../../../resources/resourceDirectory';
import { CodeInactiveRecordsDialog } from './CodeInactiveRecordsDialog';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { getResourceDef, unitYuanText } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { CopyButton } from '../../../resources/CopyValue';
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
  const [open, setOpen] = useState<Record<number, ResourceDto[] | 'loading' | 'error'>>({});
  async function toggleLines(id: number) {
    if (open[id]) { setOpen(({ [id]: _, ...rest }) => rest); return; }
    setOpen((o) => ({ ...o, [id]: 'loading' }));
    try {
      const rows:ResourceDto[]=[], seen=new Set<number>();let total:number|null=null;
      for(let page=1;;page++){
        const result=await resourceApi.list('finance-bundle-lines',{fieldKey:'bundleId',fieldValue:id,page,pageSize:200});
        if(!Number.isSafeInteger(result.total)||result.total<0||total!==null&&result.total!==total)throw new Error('组成已变化');
        total=result.total;
        for(const row of result.items){if(seen.has(row.id))throw new Error('组成读取不完整');seen.add(row.id);rows.push(row);}
        if(rows.length>total||!result.items.length&&rows.length<total)throw new Error('组成读取不完整');
        if(rows.length===total)break;
      }
      setOpen(o=>o[id]?{...o,[id]:rows}:o);
    } catch { setOpen(o=>o[id]?{...o,[id]:'error'}:o); }
  }
  const filtered = Boolean(keyword.trim() || categoryId || platform);

  const request=useRef(0);
  const reload = useCallback(async () => {
    const token=++request.current;
    try {
      const result=await resourceApi.list(TYPE, { page, pageSize, keyword: query.keyword.trim() || undefined, showHidden: true, filters: { verificationState:tab, ...(query.enabledState?{enabledState:query.enabledState}:{}), ...(categoryId ? {bundleCategoryId:categoryId} : {}), ...(query.platform ? {platformId:query.platform} : {}) } });
      const overview=await jstApi.bundleOverview();
      if(token!==request.current)return;
      setData(result);setCounts(overview.verification??overview.status);setCategoryCounts(Object.fromEntries(Object.entries(overview.byBundleLifecycleCategory??{}).map(([id,phases])=>{const states=phases[tab]??{};return[id,query.enabledState?(states[query.enabledState]??0):(states.active??0)+(states.inactive??0)];})));setError('');setSummaries({});setSummaryError('');
      if(result.items.length){
        try{const summary=await jstApi.bundleSummaries(result.items.map(row=>row.id));if(token===request.current)setSummaries(Object.fromEntries(summary.rows.map(row=>[row.id,row])));}
        catch{if(token===request.current)setSummaryError('组合汇总读取失败，请重试');}
      }
    } catch (e) { if(token===request.current)setError(e instanceof ApiError ? e.message : '加载失败'); }
  }, [page, pageSize, query, tab, categoryId]);
  useEffect(() => { const t = setTimeout(() => void reload(), 200); return () => {clearTimeout(t);request.current++;}; }, [reload]);

  const columns=[['code','组合编码'],['mainStyleCode','主款式编码'],['styleCode','款式编码'],['name','商品名称 / 简称'],['platformId','平台'],['propertiesValue','规格'],...(canCost||canPrice?[['price',canCost&&canPrice?'成本价 / 销售价':canCost?'成本价':'销售价']]:[]),['weightG','重量'],['componentCount','组成'],['packageCount','包装'],['status','状态']];
  const sortValue=(row:ResourceDto,key:string):string|number=>{
    const summary=summaries[row.id];
    if(key==='weightG'||key==='componentCount'||key==='packageCount')return summary?.[key]??-1;
    if(key==='price')return(canCost?summary?.cost:summary?.salePrice)??-1;
    if(key==='mainStyleCode')return summary?.mainStyleCode||String(row.data.mainStyleCode||'');
    if(key==='platformId')return row.refLabels.platformId||'';
    if(key==='status')return row.status==='inactive'?'停用':'启用';
    return String(row.data[key]||'');
  };
  const rows=[...(data?.items??[])];
  if(sort)rows.sort((a,b)=>{const av=sortValue(a,sort.key),bv=sortValue(b,sort.key);return sort.dir*(typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv),'zh-CN'))||b.id-a.id;});
  const money=(value:number|null|undefined)=>{if(value==null)return '待补齐';const [whole,fraction='']=unitYuanText(value).split('.');return `¥${whole}.${fraction.padEnd(3,'0')}`;};
  const cell=(row:ResourceDto,key:string)=>{
    const summary=summaries[row.id];
    if(key==='mainStyleCode')return summary?.mainStyleCode||String(row.data.mainStyleCode||'未记录');
    if(key==='name')return <>{String(row.data.name||row.title)}<small>简称：{String(row.data.shortName||'—')}</small></>;
    if(key==='price')return <>{canCost&&money(summary?.cost)}{canPrice&&<small>销售 {money(summary?.salePrice)}</small>}</>;
    if(key==='weightG')return summary?.weightG==null?'待补齐':`${(summary.weightG/1000).toFixed(6)} kg`;
    if(key==='componentCount')return <button type="button" className="link-button" onClick={()=>setBom(row)}>查看 {summary?.componentCount??'—'} 项</button>;
    if(key==='packageCount')return summary?(summary.packageCount?<><strong>{summary.packageCount} 项</strong><small title={summary.packageSummary}>{summary.packageSummary||'已维护'}</small></>:<span className="bundle-package-empty-label" title="当前BOM没有明确的包装组成；系统不会根据重量区间猜测添加包装">当前BOM无包装项</span>):'—';
    if(key==='status'){const st={tone:row.status==='inactive'?'muted':'success',label:row.status==='inactive'?'停用':'启用'};return <><span className={`pill ${st.tone==='muted'?'warn':st.tone}`}>{st.label}</span>{typeof row.data.pendingRevisionId==='number'&&<span className="pill warn">有待发布修订</span>}</>;}
    const field=def.fields.find(field=>field.key===key)!;
    return <>{displayValue(field,row)}{key==='code'&&<CopyButton value={String(row.data.code??'')} label="组合编码"/>}</>;
  };
  const verifiable = rows.filter((r) => checked.includes(r.id) && ['pending', 'reverify'].includes(r.status));
  const one = rows.find((r) => r.id === checked[0]);

  return (
    <div className="finance-code-page finance-bundle-reference">
      {applications&&<SkuApplicationCenter onClose={()=>setApplications(false)}/>}
      <div className="page-head">
        <div><h1>商品组合编码</h1><p>销售组合装，对标聚水潭组合装商品</p></div>
        <button type="button" className="secondary-button" onClick={()=>setDialog('naming')}>组合品编码配置中心</button>
        <button type="button" className="secondary-button" onClick={()=>setApplications(true)}>SKU批量申请</button>
        <details className="bundle-extra-tools"><summary>资料操作</summary><div className="pill-row"><label>销售平台<select aria-label="销售平台筛选" value={platform} onChange={e=>setPlatform(e.target.value)}><option value="">全部平台</option>{platforms.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label><button type="button" className="secondary-button" onClick={()=>setUnknownInactive(true)}>验证状态待确认的停用记录</button>
          {tab!=='verified'&&canAny('finance.jst-sync.view') && <button type="button" className="secondary-button" onClick={() => setSync('')}>聚水潭同步维护</button>}
          {can('edit') && <button type="button" className="secondary-button" disabled={checked.length !== 1 || one?.status === 'archived'} onClick={() => one && setRevise(one)}>修改构成</button>}
          {can('edit') && <button type="button" className="secondary-button" disabled={checked.length !== 1 || one?.status === 'archived'} onClick={() => one && setManual(one)}>改码 / 改名</button>}
          {can('delete') && <button type="button" className="secondary-button" disabled={checked.length !== 1} onClick={() => one && setRemove(one)}>删除 / 归档</button>}

          {can('edit') && <button type="button" className="secondary-button" onClick={() => setDialog('regen')}>按新规则重生成编码</button>}
          {can('import') && <button type="button" className="secondary-button" onClick={() => setDialog('import')}>导入</button>}
          {can('export') && <button type="button" className="secondary-button" onClick={async () => { try { const o = await resourceApi.export(TYPE, true); downloadText(o.filename, o.csv); } catch (e) { setError(e instanceof ApiError ? e.message : '导出失败'); } }}>导出</button>}

        </div></details>
      </div>
      <CodeVerificationTabs scope="bundle" value={tab} counts={counts} onChange={value=>{setTab(value);setPage(1);setChecked([]);setKeyword('');setPlatform('');setCategoryId('');setQuery({keyword:'',platform:'',enabledState:''});setData(null);setOpen({});}}/>
      <div className="tree-layout">
      <FinanceCodeDirectory cats={categories} counts={categoryCounts} kicker="组合编码分类" value={Number(categoryId)||null} onPick={id=>{setCategoryId(id?String(id):'');setPage(1);setChecked([]);setQuery({keyword,platform,enabledState});}} onManage={canAny('resource.finance-categories.edit')?()=>setManageCategories(true):undefined}/>

      <section className="card" id="bundle-verification-workspace" role="tabpanel" aria-labelledby={`bundle-verification-tab-${tab}`}><div className="bundle-list-heading"><h2>组合编码（{data?.total??0}）</h2>          {can('create') && (categoryId && leaf ? <button type="button" className="primary-button" onClick={() => setDialog('generate')}>＋ 新建组合编码</button> : <span className="muted">选择末级分类后可新增</span>)}</div>
        <form className="toolbar" onSubmit={e=>{e.preventDefault();setPage(1);setChecked([]);setQuery({keyword,platform,enabledState});}}><input className="grow" aria-label="搜索" placeholder="搜索组合编码、名称" value={keyword} onChange={(e) => setKeyword(e.target.value)} /><select aria-label="组合编码状态" value={enabledState} onChange={e=>setEnabledState(e.target.value)}><option value="">全部状态</option><option value="active">启用</option><option value="inactive">停用</option></select><button type="submit" className="secondary-button">查询</button></form>
        {tab==='verified'&&canAny('finance.jst-sync.view')&&<div className="base-batch-verification-bar"><button type="button" className="secondary-button" onClick={()=>setSync('')}>聚水潭同步维护</button></div>}
        {tab!=='verified'&&<div className="base-batch-verification-bar"><span>已选 {checked.length} 条</span>          {can('edit') && <button type="button" className="secondary-button" disabled={verifiable.length === 0} onClick={() => setVerifyIds(verifiable.map((r) => r.id))}>批量验证{verifiable.length ? `（${verifiable.length}）` : ''}</button>}
</div>}
        {error && <div role="alert" className="notice error">{error}</div>}{summaryError&&<div role="alert" className="notice error">{summaryError}<button type="button" onClick={()=>void reload()}>重试</button></div>}
        <div className="table-scroll"><table className="data-table cards-narrow">
          <thead><tr>
            {tab!=='verified'&&<th style={{ width: 32 }}><input type="checkbox" aria-label="本页全选" disabled={tab==='verified'} checked={rows.length > 0 && rows.every((r) => checked.includes(r.id))} onChange={(e) => setChecked(e.target.checked ? [...new Set([...checked, ...rows.map((r) => r.id)])] : checked.filter((id) => !rows.some((r) => r.id === id)))} /></th>}
            {columns.map(([key,label])=><th key={key} aria-sort={sort?.key===key?sort.dir===1?'ascending':'descending':'none'}><button type="button" className="link-button" onClick={()=>setSort(current=>({key,dir:current?.key===key&&current.dir===1?-1:1}))}>{label}</button></th>)}<th>操作</th>
          </tr></thead>
          <tbody>
            {rows.map((row) => {
              const lines = open[row.id];
              return (
                <Fragment key={row.id}>
                <tr className={row.id === selected ? 'selected' : undefined}>
                  {tab!=='verified'&&<td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`勾选 ${row.title}`} disabled={tab==='verified'} checked={checked.includes(row.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, row.id] : checked.filter((id) => id !== row.id))} /></td>}
                  {columns.map(([key,label])=><td key={key} data-label={label}>{cell(row,key)}</td>)}
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>{can('disable')&&<button type="button" className="link-button" onClick={async()=>{try{await resourceApi.changeStatus(TYPE,row.id,row.status==='inactive'?'active':'inactive');void reload();}catch(e){setError(e instanceof ApiError?e.message:'状态修改失败');}}}>{row.status==='inactive'?'启用':'停用'}</button>}<button type="button" className="link-button" onClick={() => { setDetailTab(undefined); setSelected(row.id); }}>查看</button>{can('edit') && row.status !== 'archived' && <><button type="button" className="link-button" onClick={() => setManual(row)}>改码 / 改名</button>{can('create') && <button type="button" className="link-button" onClick={()=>setReuse(row)}>跨平台复用</button>}<button type="button" className="link-button" onClick={() => setRevise(row)}>修改组成</button></>}<button type="button" className="link-button" onClick={() => setBom(row)}>BOM</button>{can('delete') && <button type="button" className="link-button danger" onClick={() => setRemove(row)}>删除</button>}{canAny('finance.jst-sync.view') && <button type="button" className="link-button" onClick={() => setSync(String(row.data.code ?? ''))}>同步</button>}<button type="button" className="link-button" aria-expanded={Boolean(lines)} onClick={() => void toggleLines(row.id)}>{lines ? '收起构成' : '展开构成'}</button>{can('edit') && row.status !== 'archived' && <button type="button" className="link-button" onClick={() => setProfile(row)}>编辑</button>}{can('edit') && ['pending', 'reverify'].includes(row.status) && <button type="button" className="secondary-button small" onClick={() => setVerifyIds([row.id])}>核对</button>}</td>
                </tr>
                {lines && (
                  <tr className="bundle-lines-row"><td colSpan={columns.length + (tab==='verified'?1:2)}>
                    {lines === 'loading' ? <span className="muted" role="status">正在加载构成…</span> : lines === 'error' ? <span className="muted">构成加载失败，请重试</span> : lines.length === 0 ? <span className="muted">这个组合还没有构成行</span> : (
                      <ul className="plain-list">{lines.map((l) => <li key={l.id}>{l.refLabels.baseCodeId || l.refLabels.laborId || l.refLabels.productId || l.title} × {String(l.data.qty ?? '')}{l.data.unit ? ` ${String(l.data.unit)}` : ''} <span className="muted">{roleLabel(String(l.data.role ?? ''))}</span></li>)}</ul>
                    )}
                  </td></tr>
                )}
                </Fragment>
              );
            })}
            {data && rows.length === 0 && <tr><td colSpan={columns.length + (tab==='verified'?1:2)} className="muted center">没有匹配的组合{filtered && <> <button type="button" className="link-button" onClick={() => { setKeyword(''); setCategoryId(''); setPlatform(''); setQuery({keyword:'',platform:'',enabledState:''}); setPage(1); }}>清除搜索和分类</button></>}</td></tr>}
            {!data && !error && <tr><td colSpan={columns.length + (tab==='verified'?1:2)} className="muted center">加载中…</td></tr>}
          </tbody>
        </table></div>
        <div className="card-foot code-list-pagination"><label>每页<select aria-label="每页条数" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); setChecked([]); }}>{[10,20,30,50].map(n => <option key={n} value={n}>{n}</option>)}</select>条</label><FinanceCodePagination page={page} total={data?.total ?? 0} pageSize={pageSize} onPage={value=>{setPage(value);setChecked([]);setQuery({keyword,platform,enabledState});}} /></div>
      </section>
      </div>
      {manageCategories&&<FinanceCategoryManager target="finance-categories" archiveType="bundle" selectedId={Number(categoryId)||undefined} maxDepth={4} onClose={()=>setManageCategories(false)} onChanged={()=>{setCategoryRevision(value=>value+1);void reload();}}/>}
      {unknownInactive&&<CodeInactiveRecordsDialog type={TYPE} canEnable={can('disable')} onClose={()=>setUnknownInactive(false)} onChanged={()=>void reload()}/>}
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
      {revise && <RevisionDialog bundle={revise} onClose={() => setRevise(null)} onDone={() => { setChecked([]); void reload(); }} />}
      {manual && <BundleManualDialog bundle={manual} onClose={() => setManual(null)} onDone={() => { setChecked([]); void reload(); }} />}
      {remove && <RemoveDialog bundle={remove} isAdmin={isAdmin} onClose={() => setRemove(null)} onDone={() => { setChecked([]); void reload(); }} />}
    </div>
  );
}
