import {Copy,Package,ChevronRight,ClipboardList,CheckCircle2,Trash2,Plus} from 'lucide-react';
import {SkuReusePicker,prepareSkuReuse,type ReuseSelection} from './SkuReusePicker';
import { useEffect, useState } from 'react';
import { unitYuanText, WAREHOUSE_GROUPS, WAREHOUSE_ROLE_LABEL, type SkuSpec, type WarehouseGroupKey, type WarehouseLine, type WarehouseSpec } from '@kudesi/shared';
import {SkuProductPicker,type SkuCatalogQuery,type SkuCatalogResult} from './SkuProductPicker';
import {useAuth} from '../../auth/AuthContext';
import type {ApplicationHeader,DraftReference,FlowConfirmation} from './flowApi';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../../api/client';

/** SKU 批量申请的表单与预览。申请从“申请中心”发起，预览显示在流程详情里；这里不是独立页面。 */

export const SKU_TEMPLATE = 'sku-batch-apply';
interface Opt { id: number; code: string; name: string; spec?: string;brandId?:number|null;costCents?:number|null }
type Kind = 'main' | 'gift' | 'package' | 'label' | 'other' | 'labor';

export const skuApi = {
  catalogNames:(ids:number[],runId?:number)=>api<{items:Opt[];canCost:boolean}>(`/flow/sku-apply/options?kind=names&catalog=true&ids=${ids.join(',')}${runId?`&runId=${runId}`:''}`),
  catalog:(kind:Kind,query:SkuCatalogQuery,runId?:number)=>api<SkuCatalogResult>(`/flow/sku-apply/options?kind=${kind}&catalog=true&keyword=${encodeURIComponent(query.keyword)}${query.category?`&category=${encodeURIComponent(query.category)}`:''}&page=${query.page}${runId?`&runId=${runId}`:''}`),
  draftReferences:(keyword:string)=>api<{items:DraftReference[]}>(`/flow/sku-apply/draft-references?keyword=${encodeURIComponent(keyword)}`),
  meta: (runId?:number) => api<{ scenarios: Array<{ id: number; name: string }>; platforms: Array<{ id: number; name: string }>; brands?: Array<{ id: number; name: string;code?:string }>; bundleCategories?: Array<{ id: number; name: string }> }>(`/flow/sku-apply/options?kind=meta${runId?`&runId=${runId}`:''}`),
  options: (kind: Kind, keyword: string,runId?:number) => api<{ items: Opt[] }>(`/flow/sku-apply/options?kind=${kind}&keyword=${encodeURIComponent(keyword)}${runId?`&runId=${runId}`:''}`),
  names: (ids: number[],runId?:number) => api<{ items: Opt[] }>(`/flow/sku-apply/options?kind=names&ids=${ids.join(',')}${runId?`&runId=${runId}`:''}`),
  preview: (runId: number,checkRevision?:number) => api<SkuPreviewDto>(`/flow/sku-apply/runs/${runId}/preview${checkRevision?`?checkRevision=${checkRevision}`:''}`),
  history: (mainIds: number[], keyword = '',runId?:number) => api<HistoryDto>(`/flow/sku-apply/history-config?mainIds=${mainIds.join(',')}&keyword=${encodeURIComponent(keyword)}${runId?`&runId=${runId}`:''}`),
  startSplit: (payload: Record<string, unknown>, requestKey: string) => api<{ batchKey: string; runs: Array<{ id: number; specName: string }>; failed: Array<{ specName: string; message: string }> }>('/flow/sku-apply/start-split', { method: 'POST', body: { payload, requestKey } }),
  batch: (key: string) => api<{ batchKey: string; total: number; items: Array<{ id: number; specName: string; status: string; currentStep: string }> }>(`/flow/sku-apply/batches/${encodeURIComponent(key)}`),
};
export interface BatchItem { runId: number; revision: number; stepId?: number | null }
export interface BatchBoard {
  ref: string; batchKey: string | null; batchName: string; requesterName: string; total: number; runCount: number;
  applicationHeader?:ApplicationHeader;
  workflowSteps?:ApplicationHeader['steps'];
  counts: { draft?:number;running: number; completed: number; ended: number; returned: number; mine: number };
  me: { isRequester: boolean; holdStepKey: string | null; holdStepName: string; holdCount: number; canReturnAll: boolean };
  items: Array<{ runId: number; canEditDraft?:boolean; canSaveWarehouseDraft?:boolean; specIndex: number; specName: string; specCount: number; runStatus: string; revision: number; stepId: number | null; stepKey: string | null; stepName: string; stepType?: string | null; enteredVia: string | null; dueAt: string | null; overdue: boolean; recipients: string[]; mine: boolean; canResubmit: boolean; returnReason: string | null; returnedBy: string | null; returnedAt: string | null }>;
  history: Array<{ id: number; runId: number; action: string; note: string | null; actorName: string; createdAt: string; specNames: string[] }>;
}
export interface BatchOutcome { results: Array<{ runId: number; ok: boolean; message?: string }>; ok: number; failed: number }
export const skuBatchApi = {
  board: (ref: string) => api<BatchBoard>(`/flow/sku-apply/applications/${encodeURIComponent(ref)}`),
  act: (b: { ref: string; action: 'pass' | 'return' | 'reject' | 'cancel' | 'resubmit'; items: Array<{ runId: number; canEditDraft?:boolean; revision: number; stepId?: number;confirmation?:FlowConfirmation }>; comment?: string; form?: Record<string, unknown> }) => api<BatchOutcome>('/flow/sku-apply/applications/act', { method: 'POST', body: b }),
  returnAll: (b: { ref: string; items: Array<{ runId: number; revision: number; stepId?: number }>; reason: string }) => api<{ ok: true; count: number }>('/flow/sku-apply/applications/return-all', { method: 'POST', body: b }),
  returnSpecs: (b: { runId: number; revision: number; stepId: number; specs: string[]; reason: string }) => api<{ ok: true; ref: string; newRunId: number; split: boolean }>('/flow/sku-apply/applications/return-specs', { method: 'POST', body: b }),
};
export interface HistoryDto { items: Array<{ runId: number; title: string; specName: string; exact: boolean; status: string; config: WarehouseSpec }>; names: Record<string, string> }

/** 搜索并选一个商品/人工项目。每次最多列 30 条，不显示成本。 */
function ItemPicker({ kind, label, onPick,sourceMode=false,onPickMany,runId }: { kind: Kind; label: string; onPick: (o: Opt) => void;sourceMode?:boolean;onPickMany?:(items:Opt[])=>void;runId?:number }) {
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState('');
  const [items, setItems] = useState<Opt[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open||sourceMode) return;
    let alive = true;
    const t = setTimeout(() => { skuApi.options(kind,kw,runId).then((r) => alive && setItems(r.items)).catch((e) => alive && setErr(e instanceof ApiError ? e.message : '加载失败')); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [open, kw, kind,sourceMode,runId]);
  if(open&&sourceMode)return <SkuProductPicker label={label} labor={kind==='labor'} load={query=>skuApi.catalog(kind,query,runId)} onClose={()=>setOpen(false)} onChoose={rows=>{if(onPickMany)onPickMany(rows);else for(const row of rows)onPick(row);setOpen(false);}}/>;
  if (!open) return <button type="button" className="link-button" onClick={() => setOpen(true)}>{sourceMode?<Plus size={16}/>:"＋"} {label}</button>;
  return (
    <div className="sku-picker">
      <input type="search" autoFocus placeholder="输入编码或名称搜索" aria-label={`搜索${label}`} value={kw} onChange={(e) => setKw(e.target.value)} />
      <button type="button" className="link-button" onClick={() => { setOpen(false); setKw(''); }}>收起</button>
      {err && <span role="alert" className="muted">{err}</span>}
      <ul className="sku-picker-list">
        {items === null ? <li className="muted">加载中…</li> : items.length === 0 ? <li className="muted">没有找到（只能选已验证的）</li> : items.map((o) => (
          <li key={o.id}><button type="button" onClick={() => { onPick(o); setOpen(false); setKw(''); }}><strong>{o.code}</strong> {o.name}{o.spec ? <small className="muted"> · {o.spec}</small> : null}</button></li>
        ))}
      </ul>
    </div>
  );
}

type Names = Record<number, string>;
const nameOf = (names: Names, id: number | undefined) => (id && names[id]) || (id ? `商品 #${id}` : '');

function LineRows({ lines, names, onChange,sourceQuantity=false }: { sourceQuantity?:boolean;lines: Array<{ baseCodeId: number; qty: number }>; names: Names; onChange: (l: Array<{ baseCodeId: number; qty: number }>) => void }) {
  return (
    <ul className="sku-lines">
      {lines.map((l, i) => (
        <li key={`${l.baseCodeId}-${i}`}>
          <span>{nameOf(names, l.baseCodeId)}</span>
          <input type="number" min={sourceQuantity?0.000001:1} step={sourceQuantity?'any':1} aria-label="数量" value={l.qty} onChange={(e) => onChange(lines.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} />
          <button type="button" className="link-button" aria-label="去掉" onClick={() => onChange(lines.filter((_, j) => j !== i))}>去掉</button>
        </li>
      ))}
    </ul>
  );
}

function SkuSpecBrand({spec,defaultBrand,sharedBrand,brands,onChange}:{spec:SkuSpec;defaultBrand:unknown;sharedBrand:boolean;brands:Array<{id:number;name:string;code?:string}>;onChange:(id:number|undefined)=>void}){
 const inherited = brands.find(brand => brand.id === Number(defaultBrand));
 const selected = spec.brandId ?? inherited?.id ?? '';
 return <label><span>组合品牌 *</span>
   <select aria-label={`规格 ${spec.name || '未命名'} 组合品牌`} value={selected}
     onChange={event => onChange(event.target.value ? Number(event.target.value) : undefined)}>
     <option value="">{inherited ? `沿用默认品牌：${inherited.name}` : '请选择组合品牌'}</option>
     {brands.map(brand => <option key={brand.id} value={brand.id}>{brand.name}{brand.code ? `（${brand.code}）` : ''}</option>)}
   </select>
   <small>{spec.brandId ? '本规格单独设置' : sharedBrand ? '使用本申请统一品牌' : inherited ? '使用主商品品牌' : '请为本规格选择品牌'}</small>
 </label>;
}

/** 运营填：申请名称、场景、平台、规格清单（每个规格 = 主商品 + 赠品）。 */
export function SkuSharedFields({values,onChange,includeTitle=true,readOnly=false,sourceLayout=false,runId}:{values:Record<string,unknown>;onChange:(key:string,value:unknown)=>void;includeTitle?:boolean;readOnly?:boolean;sourceLayout?:boolean;runId?:number}){
  const [meta,setMeta]=useState<Awaited<ReturnType<typeof skuApi.meta>>|null>(null);
  const platformIds=(Array.isArray(values.platformIds)?values.platformIds:[]) as number[];
  useEffect(()=>{let alive=true;skuApi.meta(runId).then(data=>{if(alive)setMeta(data);}).catch(()=>{if(alive)setMeta({scenarios:[],platforms:[],bundleCategories:[]});});return()=>{alive=false;};},[runId]);
  if(sourceLayout)return <div className="sku-reference-settings-grid"><label>组合分类<select aria-label="组合分类" disabled={readOnly} value={String(values.bundleCategoryId??'')} onChange={event=>onChange('bundleCategoryId',event.target.value?Number(event.target.value):'')}><option value="">请选择组合分类</option>{meta?.bundleCategories?.map(category=><option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>销售场景<select aria-label="销售场景" disabled={readOnly} value={String(values.scenarioId??'')} onChange={event=>onChange('scenarioId',event.target.value?Number(event.target.value):'')}>{!values.scenarioId&&<option value="">请选择销售场景</option>}{meta?.scenarios.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>默认组合品牌<select aria-label="默认组合品牌" disabled={readOnly} value={String(values.brandId??'')} onChange={event=>onChange('brandId',event.target.value?Number(event.target.value):'')}><option value="">请选择默认品牌</option>{meta?.brands?.map(brand=><option key={brand.id} value={brand.id}>{brand.name}{brand.code?`（${brand.code}）`:''}</option>)}</select></label><fieldset disabled={readOnly}><legend>销售平台</legend>{meta?.platforms.map(platform=><label key={platform.id}><input type="checkbox" checked={platformIds.includes(platform.id)} onChange={event=>onChange('platformIds',event.target.checked?[...platformIds,platform.id]:platformIds.filter(id=>id!==platform.id))}/>{platform.name}</label>)}</fieldset></div>;
  return <fieldset disabled={readOnly} className="sku-shared-fields">
      <div className="form-grid">
        {includeTitle && <label className="wide"><span>申请名称<b className="req"> *</b></span><input value={String(values.batchName ?? '')} maxLength={140} placeholder="例如：10 月新品组合" onChange={(e) => onChange('batchName', e.target.value)} /></label>}
        <label><span>销售场景<b className="req"> *</b></span>
          <select value={String(values.scenarioId ?? '')} onChange={(e) => onChange('scenarioId', e.target.value ? Number(e.target.value) : '')}>
            <option value="">（请选择）</option>
            {meta?.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <small className="muted">整张申请的所有规格都用这个场景</small>
        </label>
        <label className="wide"><span>组合分类<b className="req"> *</b></span>
          <select aria-label="组合分类" value={String(values.bundleCategoryId ?? '')} onChange={(e) => onChange('bundleCategoryId', e.target.value ? Number(e.target.value) : '')}>
            <option value="">（请选择最末级分类）</option>
            {meta?.bundleCategories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <small className="muted">组合分类树里的最末级分类；生成的组合都归到这个分类，成本表分类利润率按它汇总</small>
        </label>
        <label><span>组合品牌</span>
          <select aria-label="组合品牌" value={String(values.brandId ?? '')} onChange={(e) => onChange('brandId', e.target.value ? Number(e.target.value) : '')}>
            <option value="">沿用主商品品牌</option>
            {meta?.brands?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <div className="wide"><span>销售平台<b className="req"> *</b></span>
          <div className="check-list" role="group" aria-label="销售平台">
            {meta?.platforms.map((p) => (
              <label key={p.id} className="check"><input type="checkbox" checked={platformIds.includes(p.id)} onChange={(e) => onChange('platformIds', e.target.checked ? [...platformIds, p.id] : platformIds.filter((x) => x !== p.id))} />{p.name}</label>
            ))}
          </div>
          <small className="muted">每个规格在每个选中的平台各生成一个商品组合编码</small>
        </div>
      </div>
  </fieldset>;
}

export function SkuApplyFields({ values, onChange,hideShared=false,singleSpec=false,sourceLayout=false,runId,sourceStageName,sourceHandlerName }: { values: Record<string, unknown>; onChange: (key: string, v: unknown) => void;hideShared?:boolean;singleSpec?:boolean;sourceLayout?:boolean;runId?:number;sourceStageName?:string;sourceHandlerName?:string }) {
  const [names, setNames] = useState<Names>({});
  const [lineMeta,setLineMeta]=useState<Record<number,Opt>>({}),[sourceCanCost,setSourceCanCost]=useState(false);
  const [mainBrands,setMainBrands]=useState<Record<number,number|null>>({});
  const [brands,setBrands]=useState<Array<{id:number;name:string;code?:string}>>([]);
  useEffect(()=>{let alive=true;skuApi.meta().then(meta=>{if(alive)setBrands(meta.brands??[]);}).catch(()=>undefined);return()=>{alive=false;};},[]);
  const specs = (Array.isArray(values.specs) ? values.specs : []) as SkuSpec[];
  // 重新提交时，已有的商品要显示名称
  useEffect(() => {
    const need = [...new Set(specs.flatMap((s) => [...s.main, ...s.gift].map((l) => l.baseCodeId)))].filter((id) => !names[id]||!Object.hasOwn(mainBrands,id));
    let alive=true;if(need.length)(sourceLayout?skuApi.catalogNames(need,runId):skuApi.names(need,runId)).then(r=>{if(alive){setNames(cur=>({...cur,...Object.fromEntries(r.items.map(o=>[o.id,`${o.code} ${o.name}`]))}));setMainBrands(cur=>({...cur,...Object.fromEntries(r.items.map(o=>[o.id,o.brandId??null]))}));setLineMeta(cur=>({...cur,...Object.fromEntries(r.items.map(o=>[o.id,o]))}));if('canCost' in r)setSourceCanCost(r.canCost===true);}}).catch(()=>undefined);return()=>{alive=false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.specs]);
  const [series, setSeries] = useState<Record<number, string>>({});
  const [seriesError, setSeriesError] = useState('');
  const setSpecs = (next: SkuSpec[]) => onChange('specs', next);
  /** 数量系列（旧系统“批量生成规格”）：以这个规格为模板，按 1,2,5,10 这样的数量各生成一个规格，赠品照旧，仓库组成之后再配 */
  function makeSeries(i: number) {
    const base = specs[i];
    const nums = (series[i] ?? '').split(/[,，\s]+/).filter(Boolean).map(Number);
    if (base.main.length !== 1) { setSeriesError('数量系列要求这个规格只有一个主商品'); return; }
    if (!nums.length || nums.length > 30 || nums.some((n) => !Number.isSafeInteger(n) || n <= 0) || new Set(nums).size !== nums.length) { setSeriesError('请输入 1 到 30 个不重复的正整数，用逗号分隔'); return; }
    if (specs.length + nums.length > 100) { setSeriesError('规格总数不能超过 100 个'); return; }
    const made = nums.map((n): SkuSpec => ({ ...base, name: `${base.name || '规格'} · ${n}件`, main: [{ ...base.main[0], qty: n }], gift: base.gift.map((l) => ({ ...l })), reuseReason: '' }));
    setSeriesError('');
    setSeries((cur) => ({ ...cur, [i]: '' }));
    setSpecs([...specs.slice(0, i + 1), ...made, ...specs.slice(i + 1)]);
  }
  const patch = (i: number, p: Partial<SkuSpec>) => setSpecs(specs.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const pick = (i: number, role: 'main' | 'gift', o: Opt) => {
    setNames((cur) => ({ ...cur, [o.id]: `${o.code} ${o.name}` }));
    const cur = specs[i][role];
    patch(i, { [role]: cur.some((l) => l.baseCodeId === o.id) ? cur : [...cur, { baseCodeId: o.id, qty: 1 }] } as Partial<SkuSpec>);
  };
  const pickMany=(index:number,role:'main'|'gift',items:Opt[])=>{setLineMeta(current=>({...current,...Object.fromEntries(items.map(item=>[item.id,item]))}));setSourceCanCost(items.some(item=>Object.hasOwn(item,'costCents')));setNames(current=>({...current,...Object.fromEntries(items.map(item=>[item.id,`${item.code} ${item.name}`]))}));const merged=new Map(specs[index][role].map(line=>[line.baseCodeId,line.qty]));for(const item of items)merged.set(item.id,(merged.get(item.id)??0)+1);patch(index,{[role]:[...merged].map(([baseCodeId,qty])=>({baseCodeId,qty}))});};
  if(sourceLayout&&singleSpec){const spec=specs[0];if(!spec)return <p>尚无规格</p>;const required=['主商品','销售平台','组合分类','组合品牌'],missing=[!spec.main.length?'主商品':'',!(Array.isArray(values.platformIds)&&values.platformIds.length)?'销售平台':'',!values.bundleCategoryId?'组合分类':'',!(spec.brandId||values.brandId||mainBrands[spec.main[0]?.baseCodeId])?'组合品牌':''].filter(Boolean);return <div className="sku-reference-editor-layout"><div className="sku-reference-editor-body"><label className="sku-reference-spec-label">内部规格名称<input aria-label="内部规格名称" value={spec.name} maxLength={100} placeholder="例如：太空6号 5斤 · 淘宝" onChange={event=>patch(0,{name:event.target.value})}/></label><details className="sku-reference-upstream" open><summary><ChevronRight className="sku-reference-disclosure" size={16}/><ClipboardList size={17}/><span>运营申请资料</span><small>{spec.main.length} 项主商品 · {spec.gift.length} 项赠品</small></summary><SkuSpecBrand spec={spec} brands={brands} sharedBrand={!!values.brandId} defaultBrand={values.brandId||mainBrands[spec.main[0]?.baseCodeId]} onChange={brandId=>patch(0,{brandId})}/>{(['main','gift'] as const).map(role=><section className="sku-reference-line-section" key={role}><header><strong>{role==='main'?'主商品':'赠品'} <small className="sku-reference-item-count">{spec[role].length} 项</small></strong><ItemPicker sourceMode runId={runId} onPickMany={items=>pickMany(0,role,items)} kind={role} label={`添加${role==='main'?'主商品':'赠品'}`} onPick={option=>pick(0,role,option)}/></header>{spec[role].length?<ul className="sku-reference-component-lines">{spec[role].map((line,index)=>{const meta=lineMeta[line.baseCodeId];return <li key={`${line.baseCodeId}:${index}`}><span><strong>{meta?.name||names[line.baseCodeId]||`项目 #${line.baseCodeId}`}</strong><small>{meta?.code} {meta?.spec}</small></span><label>数量<input aria-label={`${role==='main'?'主商品':'赠品'}数量 ${index+1}`} type="number" min={.000001} step="any" value={line.qty} onChange={event=>patch(0,{[role]:spec[role].map((old,at)=>at===index?{...old,qty:Number(event.target.value)}:old)})}/></label><span>{sourceCanCost&&(meta?.costCents==null?'—':`¥${(meta.costCents*line.qty/100).toFixed(3)}`)}</span><button type="button" title="移除" aria-label={`移除${role==='main'?'主商品':'赠品'} ${index+1}`} onClick={()=>patch(0,{[role]:spec[role].filter((_,at)=>at!==index)})}><Trash2 size={15}/></button></li>;})}</ul>:<p className="muted">{role==='gift'?'无赠品':'未添加'}</p>}</section>)}<label className="sku-reference-note">运营需求<textarea aria-label="运营需求" maxLength={1000} value={spec.note??''} onChange={event=>patch(0,{note:event.target.value})}/></label></details></div><aside className="sku-reference-checklist"><small>当前环节</small><h3>{sourceStageName||'运营申请'}</h3><p>{sourceHandlerName||'申请人'}</p><h3>资料完整度</h3>{required.map(label=><div key={label} className={missing.includes(label)?'pending':'ready'}><CheckCircle2 size={16}/><span>{label}</span><small>{missing.includes(label)?'待补齐':'已填写'}</small></div>)}{missing.length>0&&<p className="sku-application-warning">待补：{missing.join('、')}</p>}<small>以保存后的查重与资料校验结果为准</small></aside></div>;}
  return (
    <div className="sku-form">
      {!hideShared&&<SkuSharedFields values={values} onChange={onChange}/>}
      {!singleSpec&&<h4 className="section-title">规格清单（{specs.length} 个，最多 100 个）</h4>}
      {specs.map((s, i) => (
        <section key={i} className="sku-spec card">
          <div className="between">
            <label className="grow"><span>{singleSpec?'内部规格名称':`规格 ${i+1} 名称`}</span><input value={s.name} maxLength={100} onChange={(e) => patch(i, { name: e.target.value })} /></label>
            {!singleSpec&&<span className="row-actions">
              <button type="button" className="link-button" disabled={specs.length >= 100} onClick={() => setSpecs([...specs.slice(0, i + 1), { ...s, name: s.name ? `${s.name}（副本）` : '', main: s.main.map((l) => ({ ...l })), gift: s.gift.map((l) => ({ ...l })), reuseReason: '' }, ...specs.slice(i + 1)])}>复制这个规格</button>
              <button type="button" className="link-button" onClick={() => { if ((s.name || s.main.length || s.gift.length) && !window.confirm(`确定删除规格 ${i + 1}${s.name ? `「${s.name}」` : ''}？已选的商品会一起去掉。`)) return; setSpecs(specs.filter((_, j) => j !== i)); }}>删除这个规格</button>
            </span>}
          </div>
          <div className="sku-cols">
            <div><strong>主商品（必填）</strong><LineRows lines={s.main} names={names} onChange={(l) => patch(i, { main: l })} /><ItemPicker kind="main" label="添加主商品" onPick={(o) => pick(i, 'main', o)} /></div>
            <div><strong>赠品</strong><LineRows lines={s.gift} names={names} onChange={(l) => patch(i, { gift: l })} /><ItemPicker kind="gift" label="添加赠品" onPick={(o) => pick(i, 'gift', o)} /></div>
          </div>
          {!singleSpec&&s.main.length === 1 && (
            <div className="sku-series row-actions">
              <input aria-label={`规格 ${i + 1} 数量系列`} placeholder="数量系列，如 1, 2, 5, 10" value={series[i] ?? ''} onChange={(e) => setSeries((cur) => ({ ...cur, [i]: e.target.value }))} />
              <button type="button" className="secondary-button small" disabled={!(series[i] ?? '').trim() || specs.length >= 100} onClick={() => makeSeries(i)}>按数量生成规格</button>
            </div>
          )}
          <SkuSpecBrand spec={s} brands={brands} sharedBrand={!!values.brandId} defaultBrand={values.brandId||mainBrands[s.main[0]?.baseCodeId]} onChange={brandId=>patch(i,{brandId})}/>
          <label><span>{singleSpec?'运营需求':'备注（选填）'}</span>{singleSpec?<textarea value={s.note??''} maxLength={1000} onChange={event=>patch(i,{note:event.target.value})}/>:<input value={s.note ?? ''} maxLength={1000} onChange={(e) => patch(i, { note: e.target.value })} />}</label>
          <label><span>已有相同组合时，为什么还要申请（选填）</span><input value={s.reuseReason ?? ''} maxLength={500} placeholder="系统里已有主商品、赠品相同的编码时必须填写" onChange={(e) => patch(i, { reuseReason: e.target.value })} /></label>
        </section>
      ))}
      {seriesError && <div role="alert" className="notice error">{seriesError}</div>}
      {!singleSpec&&<button type="button" className="secondary-button" disabled={specs.length >= 100} onClick={() => setSpecs([...specs, { name: '', main: [], gift: [] }])}>＋ 添加规格</button>}
      {!singleSpec&&specs.length > 1 && (
        <label className="check sku-split"><input type="checkbox" checked={values.splitSpecs === true} onChange={(e) => onChange('splitSpecs', e.target.checked)} /> 每个规格独立办理（拆成 {specs.length} 条流程，仓库、财务可以各自先办先走；同批可互相查看）</label>
      )}
      {!singleSpec&&<label className="wide"><span>备注</span><textarea rows={2} maxLength={500} value={String(values.note ?? '')} onChange={(e) => onChange('note', e.target.value)} /></label>}
    </div>
  );
}

const emptyWh = (): WarehouseSpec => ({ lines: [], notRequired: {} });

/** 仓库填：每个规格的包装、标签/说明书、其他打包材料、人工。每类要么选好，要么写明不需要的原因。 */
export function SkuWarehouseFields({ specs, values, onChange,sourceQuantity=false,runId,initialItems,canCost=false,targetWeightG=null,onReuseApplied }: {onReuseApplied?:(sourceId:string)=>void; targetWeightG?:number|null; canCost?:boolean;initialItems?:Record<string,Opt>;sourceQuantity?:boolean;runId?:number;specs: SkuSpec[]; values: Record<string, unknown>; onChange: (key: string, v: unknown) => void }) {
  const config = specs.map((_, i) => ((values.config as WarehouseSpec[] | undefined)?.[i] ?? emptyWh()));
  const [names, setNames] = useState<Record<string, string>>({});
  const [sourceItems,setSourceItems]=useState<Record<string,Opt>>({});
  useEffect(()=>{if(initialItems){setSourceItems(current=>({...current,...initialItems}));setNames(current=>({...current,...Object.fromEntries(Object.entries(initialItems).map(([key,item])=>[key,`${item.code} ${item.name}`]))}));}},[initialItems]);
  const set = (i: number, w: WarehouseSpec) => onChange('config', config.map((c, j) => (j === i ? w : c)));
  const kindOf = (g: WarehouseGroupKey): Kind => g;
  const [hist, setHist] = useState<{ index: number; kw: string; data: HistoryDto | null; error: string } | null>(null);
  const [reused, setReused] = useState<Record<number, string>>({});
  async function openHistory(i: number, kw = '') {
    setHist({ index: i, kw, data: null, error: '' });
    try { setHist({ index: i, kw, data: await skuApi.history(specs[i].main.map((l) => l.baseCodeId), kw,runId), error: '' }); }
    catch (e) { setHist({ index: i, kw, data: null, error: e instanceof ApiError ? e.message : '历史配置加载失败' }); }
  }
  function applyHistory(i: number, h: HistoryDto['items'][number], data: HistoryDto) {
    if (config[i].lines.length && !window.confirm('将替换这个规格已选的包装、标签、打包材料、人工和“不需要”的原因，确定？')) return;
    setNames((cur) => {
      const next = { ...cur };
      for (const l of h.config.lines) {
        const g = WAREHOUSE_GROUPS.find((x) => x.roles.includes(l.role))!;
        next[`${g.key}:${l.role === 'labor' ? `L${l.laborId}` : l.baseCodeId}`] = data.names[l.role === 'labor' ? `l${l.laborId}` : `b${l.baseCodeId}`] ?? '';
      }
      return next;
    });
    set(i, { lines: h.config.lines.map((l) => ({ ...l })), notRequired: { ...h.config.notRequired } });
    setReused((cur) => ({ ...cur, [i]: `来自申请 #${h.runId}「${h.specName}」`.slice(0, 80) }));
    setHist(null);
  }
  const [sourceSelection,setSourceSelection]=useState<ReuseSelection|null>(null),[reuseOpen,setReuseOpen]=useState(false),[replaceConfirm,setReplaceConfirm]=useState(false),[reuseIssues,setReuseIssues]=useState<string[]>([]),[appliedSource,setAppliedSource]=useState<{name:string;statuses:Record<string,string>;keys:string[]}|null>(null);
  useEffect(()=>{const info=values.reuseInfo as {sourceName?:string;statuses?:Record<string,string>;issues?:string[];lineKeys?:string[];laborKeys?:string[]}|undefined;if(info?.sourceName){setAppliedSource({name:info.sourceName,statuses:info.statuses??{},keys:[...(info.lineKeys??[]),...(info.laborKeys??[]).map(id=>'labor:'+id)]});setReuseIssues(info.issues??[]);}else{setAppliedSource(null);setReuseIssues([]);}},[values.reuseInfo]);
  function applySource(index:number,confirmed=false){if(!sourceSelection)return;const old=config[index];if(!confirmed&&(old.lines.length||Object.values(old.notRequired).some(Boolean)||values.note)){setReplaceConfirm(true);return;}const prepared=prepareSkuReuse(sourceSelection.source,sourceSelection.references,targetWeightG);set(index,prepared.config);onChange('note',prepared.note);setReuseIssues(prepared.issues);setAppliedSource({name:sourceSelection.source.name,statuses:prepared.statuses,keys:prepared.config.lines.map(line=>line.role+':'+(line.laborId??line.baseCodeId))});onReuseApplied?.(sourceSelection.source.id);setReplaceConfirm(false);setSourceItems(current=>({...current,...Object.fromEntries(sourceSelection.references.map(item=>[`${item.kind==='labor'?'labor':WAREHOUSE_GROUPS.find(group=>group.roles.some(role=>sourceSelection.source.config.lines.some(line=>line.baseCodeId===item.id&&line.role===role)))?.key}:${item.kind==='labor'?'L':''}${item.id}`,item]))}));}
  if(sourceQuantity)return <div className="sku-reference-warehouse-fields">{specs.map((spec,index)=>{const item=config[index];return <section key={index}>
    <section className="sku-reference-reuse-panel"><header><strong><Copy size={16}/>复用仓库配置</strong><button type="button" onClick={()=>setReuseOpen(value=>!value)}>{reuseOpen?'收起搜索':'搜索配置过的商品'}</button></header><p>按主商品总重量辅助匹配，复用后请逐项核对，再保存并校验。</p>{reuseOpen&&runId&&<><SkuReusePicker runId={runId} targetWeightG={targetWeightG} onSelection={setSourceSelection}/><button type="button" disabled={!sourceSelection} onClick={()=>applySource(index)}>填入配置</button></>}{replaceConfirm&&<div role="alert"><p>将替换当前包装、标签、打包材料、人工、无需原因和仓库说明。</p><button type="button" onClick={()=>setReplaceConfirm(false)}>取消</button><button type="button" onClick={()=>applySource(index,true)}>确认替换并填入</button></div>}{appliedSource&&<div className="sku-reference-reuse-summary"><strong>来源：{appliedSource.name} · 蓝色为复用内容，橙色为待匹配项</strong></div>}{reuseIssues.map((issue,index)=><p role="status" key={index}>{issue}</p>)}</section>
    <h3 className="sku-reference-section-title"><Package size={18}/>发货组成</h3>
    {WAREHOUSE_GROUPS.map(original=>{const group={...original,label:original.key==='label'?'标签说明书贴纸':original.key==='other'?'打包材料':original.label};const rows=item.lines.map((line,at)=>({line,at})).filter(({line})=>group.roles.includes(line.role));return <section className={`sku-reference-line-section ${appliedSource?.statuses[group.key]==='unmatched'?'sku-reference-reuse-unmatched':''}`} key={group.key}><header><strong>{group.label} <small>{rows.length} 项</small>{appliedSource&&<small className="sku-reference-reuse-tag">{appliedSource.statuses[group.key]==='copied'?'已复用 · 待核对':'无法完整匹配 · 请补充核对'}</small>}</strong><ItemPicker sourceMode runId={runId} kind={kindOf(group.key)} label={`添加${group.label}`} onPickMany={options=>{setSourceItems(current=>({...current,...Object.fromEntries(options.map(option=>[`${group.key}:${group.key==='labor'?'L':''}${option.id}`,option]))}));const lines=item.lines.map(line=>({...line}));for(const option of options){const role=group.roles[0],found=lines.find(line=>line.role===role&&(role==='labor'?line.laborId:line.baseCodeId)===option.id);if(found)found.qty+=1;else lines.push(role==='labor'?{role,laborId:option.id,qty:1}:{role,baseCodeId:option.id,qty:1});}setNames(current=>({...current,...Object.fromEntries(options.map(option=>[`${group.key}:${group.key==='labor'?'L':''}${option.id}`,`${option.code} ${option.name}`]))}));set(index,{...item,lines});}} onPick={()=>undefined}/></header>
      {rows.map(({line,at},n)=>{const metadata=sourceItems[`${group.key}:${line.role==='labor'?`L${line.laborId}`:line.baseCodeId}`];const reused=appliedSource?.keys.includes(line.role+':'+(line.laborId??line.baseCodeId));return <div className={`sku-reference-readonly-component${reused?' sku-reference-reused-value':''}`} key={at}><span><strong>{metadata?.name||names[`${group.key}:${line.role==='labor'?`L${line.laborId}`:line.baseCodeId}`]||`项目 #${line.baseCodeId??line.laborId}`}</strong><small>{metadata?.code} {metadata?.spec}{reused&&' · 复用参考，需核对'}</small></span><label>数量<input aria-label={`${group.label}数量 ${n+1}`} type="number" min={.000001} step="any" value={line.qty} onChange={event=>set(index,{...item,lines:item.lines.map((old,i)=>i===at?{...old,qty:Number(event.target.value)}:old)})}/></label><span>{canCost&&(metadata?.costCents==null?'—':`¥${(metadata.costCents*line.qty/100).toFixed(3)}`)}</span><button type="button" aria-label={`移除${group.label} ${n+1}`} onClick={()=>set(index,{...item,lines:item.lines.filter((_,i)=>i!==at)})}><Trash2 size={15}/></button></div>;})}
      {!rows.length&&<label className="sku-reference-omission">无需{group.label}原因<input aria-label={`无需${group.label}原因`} maxLength={200} value={item.notRequired[group.key]??''} onChange={event=>set(index,{...item,notRequired:{...item.notRequired,[group.key]:event.target.value}})}/></label>}
    </section>;})}
  </section>;})}</div>;
  return (
    <div className={sourceQuantity?"sku-form sku-reference-warehouse-fields":"sku-form"}>
      {specs.map((s, i) => {
        const w = config[i];
        return (
          <section key={i} className="sku-spec card">
            <div className="between"><strong>规格：{s.name}</strong>
              <button type="button" className="link-button" aria-label={`复用规格 ${s.name} 的历史仓库配置`} onClick={() => void openHistory(i)}>复用历史配置</button>
              {specs.length > 1 && <button type="button" className="link-button" aria-label={`把规格 ${s.name} 的配置套用到其他规格`} onClick={() => {
                const others = config.filter((_, j) => j !== i);
                if (others.some((c) => c.lines.length) && !window.confirm('其他规格已选的包装、标签等会被覆盖，确定套用？')) return;
                onChange('config', config.map((c, j) => (j === i ? c : { lines: w.lines.map((l) => ({ ...l })), notRequired: { ...w.notRequired } })));
              }}>套用到其他规格</button>}
            </div>
            {hist?.index === i && (
              <div className="sku-history card">
                <div className="between"><strong>复用历史仓库配置</strong><button type="button" className="link-button" onClick={() => setHist(null)}>收起</button></div>
                <p className="muted">默认列出主商品相同的规格；也可以按规格名或申请名搜索。复用后请逐项核对，提交时仍会按现在的规则完整校验。</p>
                <input type="search" aria-label="搜索历史规格" placeholder="按规格名或申请名搜索" value={hist.kw} onChange={(e) => void openHistory(i, e.target.value)} />
                {hist.error && <div role="alert" className="notice error">{hist.error}</div>}
                {!hist.data && !hist.error && <p className="muted">加载中…</p>}
                {hist.data && hist.data.items.length === 0 && <p className="muted">没有找到配置过的规格</p>}
                <ul className="sku-lines">
                  {hist.data?.items.map((h) => (
                    <li key={`${h.runId}-${h.specName}`}>
                      <span>{h.specName} <small className="muted">· 申请 #{h.runId}{h.exact ? ' · 主商品相同' : ''} · {h.config.lines.length} 项物料</small></span>
                      <button type="button" className="link-button" aria-label={`填入申请 #${h.runId} 的配置`} onClick={() => applyHistory(i, h, hist.data!)}>填入</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {reused[i] && <div className="notice" role="status">已复用历史配置（{reused[i]}），请逐项核对。</div>}
            {WAREHOUSE_GROUPS.map((g) => {
              const mine = w.lines.map((l, idx) => ({ l, idx })).filter(({ l }) => g.roles.includes(l.role));
              return (
                <div key={g.key} className="sku-group">
                  <span className="sku-group-title">{g.label}</span>
                  <ul className="sku-lines">
                    {mine.map(({ l, idx }) => (
                      <li key={idx}>
                        <span>{names[`${g.key}:${l.baseCodeId ?? `L${l.laborId}`}`] ?? (l.role === 'labor' ? `人工 #${l.laborId}` : `商品 #${l.baseCodeId}`)}</span>
                        {g.key === 'label' && (
                          <select aria-label="类别" value={l.role} onChange={(e) => set(i, { ...w, lines: w.lines.map((x, j) => (j === idx ? { ...x, role: e.target.value as WarehouseLine['role'] } : x)) })}>
                            <option value="label">标签</option><option value="instruction">说明书</option>
                          </select>
                        )}
                        <input type="number" min={sourceQuantity?0.000001:0.001} step="any" aria-label="数量" value={l.qty} onChange={(e) => set(i, { ...w, lines: w.lines.map((x, j) => (j === idx ? { ...x, qty: Number(e.target.value) } : x)) })} />
                        <button type="button" className="link-button" onClick={() => set(i, { ...w, lines: w.lines.filter((_, j) => j !== idx) })}>去掉</button>
                      </li>
                    ))}
                  </ul>
                  <ItemPicker sourceMode={sourceQuantity} runId={runId} onPickMany={items=>{const next=w.lines.map(line=>({...line}));for(const option of items){const role=g.roles[0],found=next.find(line=>line.role===role&&(role==='labor'?line.laborId:line.baseCodeId)===option.id);if(found)found.qty+=1;else next.push(role==='labor'?{role,laborId:option.id,qty:1}:{role,baseCodeId:option.id,qty:1});}setNames(current=>({...current,...Object.fromEntries(items.map(option=>[`${g.key}:${g.key==='labor'?'L':''}${option.id}`,`${option.code} ${option.name}`]))}));set(i,{...w,lines:next});}} kind={kindOf(g.key)} label={`添加${g.label}`} onPick={(o) => {
                    const role: WarehouseLine['role'] = g.key;
                    setNames((cur) => ({ ...cur, [`${g.key}:${g.key === 'labor' ? `L${o.id}` : o.id}`]: `${o.code} ${o.name}` }));
                    const line: WarehouseLine = g.key === 'labor' ? { role, laborId: o.id, qty: 1 } : { role, baseCodeId: o.id, qty: 1 };
                    set(i, { ...w, lines: [...w.lines, line], notRequired: { ...w.notRequired, [g.key]: undefined } });
                  }} />
                  {mine.length === 0 && (
                    <label className="sku-why"><span>不需要{g.label}的原因<b className="req"> *</b></span>
                      <input value={w.notRequired[g.key] ?? ''} maxLength={200} placeholder="没有选物料时必须写明原因" onChange={(e) => set(i, { ...w, notRequired: { ...w.notRequired, [g.key]: e.target.value } })} />
                    </label>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

export interface SkuPreviewDto {
  applicationWarnings?: string[];
  generatedDuplicates?:Array<{id:number;code:string;name:string}>;duplicateToken?:string;
  batch?: { key: string; index: number | null; total: number | null } | null;
  runId: number; status: string; batchName: string; scenario: string; platforms: Array<{ id: number; name: string }>; warehouseDone: boolean; canCost: boolean; planError: string; costNote: string;
  specs: Array<{
    name: string;brandName?:string; note: string; reuseReason: string; weightG: number|null; totalCost?: number|null; notRequired: Partial<Record<WarehouseGroupKey, string>>;
    lines: PreviewLine[]; warehouse: PreviewLine[];
    targets: Array<{ platformId?:number;platformName: string; code: string; name: string; reuse: { code: string } | null }>;
    created: Array<{ bundleId: number; code: string; reused: boolean }>;
  }>;
}
interface PreviewLine { spec?:string;role:string;baseCodeId?:number;laborId?:number; roleLabel: string; code: string; name: string; qty: number; weightG: number | null; cost?: number | null }
const yuan = (c: number) => `¥${unitYuanText(c)}`;

/** 流程详情里的规格明细：会生成（或已生成）哪些编码、物料、重量，有成本权限的人还能看到成本。 */
export function SkuPreview(props:{runId:number;refreshKey:number}){
  const {user}=useAuth();const identity=JSON.stringify([user?.companyId,user?.id,user?.permissions.isCompanyAdmin,[...(user?.permissions.allow??[])].sort(),[...(user?.permissions.deny??[])].sort()]);
  return <SkuPreviewView key={`${identity}:${props.runId}:${props.refreshKey}`} {...props}/>;
}
function SkuPreviewView({ runId, refreshKey }: { runId: number; refreshKey: number }) {
  const [data, setData] = useState<SkuPreviewDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { let alive=true;setData(null);setError('');skuApi.preview(runId).then(value=>{if(alive)setData(value);}).catch((e) => {if(alive)setError(e instanceof ApiError ? e.message : '规格明细加载失败');});return()=>{alive=false;}; }, [runId, refreshKey]);
  if (error) return <p role="alert" className="muted">{error}</p>;
  if (!data) return <p className="muted">正在加载规格明细…</p>;
  const lineTable = (lines: PreviewLine[]) => (
    <table className="data-table compact">
      <thead><tr><th>类别</th><th>编码</th><th>名称</th><th className="num">数量</th><th className="num">重量(克)</th>{data.canCost && <th className="num">单价成本</th>}</tr></thead>
      <tbody>{lines.map((l, i) => (
        <tr key={i}><td>{l.roleLabel}</td><td className="mono">{l.code}</td><td>{l.name}</td><td className="num">{l.qty}</td><td className="num">{l.weightG ?? '—'}</td>{data.canCost && <td className="num">{l.cost == null ? '—' : yuan(l.cost)}</td>}</tr>
      ))}</tbody>
    </table>
  );
  return (
    <div className="sku-preview">
      {data.batch && <BatchPeers batchKey={data.batch.key} runId={runId} index={data.batch.index} total={data.batch.total} />}
      <p className="muted">销售场景：{data.scenario} · 销售平台：{data.platforms.map((p) => p.name).join('、')} · {data.warehouseDone ? '仓库已提交配置' : '仓库还没有提交配置'}</p>
      {data.planError && <div role="alert" className="notice error">{data.planError}</div>}
      {!!data.applicationWarnings?.length && <p className="notice">其他未完成申请有相同主商品及数量：{data.applicationWarnings.join("、")}。请核对，编码未冲突时可继续。</p>}
      {data.specs.map((s) => (
        <section key={s.name} className="sku-spec card">
          <strong>{s.name}</strong>
          <span className="muted"> · 总重量 {s.weightG==null?'未记录':`${s.weightG} 克`}{data.canCost && s.totalCost !== undefined ? ` · 物料成本 ${s.totalCost==null?'未记录':yuan(s.totalCost)}（${data.costNote}）` : ''}</span>
          {s.note && <div className="muted">备注：{s.note}</div>}
          {s.reuseReason && <div className="muted">已有相同组合，仍申请的原因：{s.reuseReason}</div>}
          {lineTable([...s.lines, ...s.warehouse])}
          {Object.entries(s.notRequired).map(([k, why]) => <div key={k} className="muted">不需要{WAREHOUSE_GROUPS.find((g) => g.key === k)?.label ?? WAREHOUSE_ROLE_LABEL[k as keyof typeof WAREHOUSE_ROLE_LABEL]}：{why}</div>)}
          {s.created.length > 0 ? (
            <p>已生成商品组合编码：{s.created.map((c) => <span key={c.bundleId} className="pill ok mono" style={{ marginRight: 6 }}>{c.code}{c.reused ? '（沿用已有）' : ''}</span>)}</p>
          ) : s.targets.length > 0 && (
            <table className="data-table compact">
              <thead><tr><th>平台</th><th>将生成的组合编码</th><th>组合名称</th><th>状态</th></tr></thead>
              <tbody>{s.targets.map((t) => <tr key={t.code}><td>{t.platformName}</td><td className="mono">{t.code}</td><td>{t.name}</td><td>{t.reuse ? '沿用已有编码' : '新建'}</td></tr>)}</tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}

/** 拆开办理的同一批申请：每个规格现在到哪一步了 */
function BatchPeers({ batchKey, runId, index, total }: { batchKey: string; runId: number; index: number | null; total: number | null }) {
  const [list, setList] = useState<Awaited<ReturnType<typeof skuApi.batch>> | null>(null);
  useEffect(() => { skuApi.batch(batchKey).then(setList).catch(() => setList(null)); }, [batchKey]);
  const STATUS: Record<string, string> = { running: '办理中', completed: '已完成', cancelled: '已废除', rejected: '被拒绝' };
  return (
    <div className="notice sku-batch" aria-label="同批申请">
      <strong>独立办理：第 {index ?? '?'} / {total ?? '?'} 个规格</strong>
      {' '}<Link to={`/workbench/todos?batch=${encodeURIComponent(batchKey)}`} className="link-button">打开申请汇总（批量办理）</Link>
      {list && (
        <ul className="plain-list">
          {list.items.map((it) => <li key={it.id}>#{it.id} {it.specName} · {it.status === 'running' ? `停在「${it.currentStep}」` : STATUS[it.status] ?? it.status}{it.id === runId ? '（当前）' : ''}</li>)}
        </ul>
      )}
    </div>
  );
}
