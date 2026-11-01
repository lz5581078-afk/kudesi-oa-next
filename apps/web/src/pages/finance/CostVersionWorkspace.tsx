import { useCallback, useEffect, useRef, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { resourceApi, type ResourceDto } from '../../resources/api';
import { RecordForm, ReasonDialog } from '../../resources/RecordForm';
import { useResourceCan } from '../../resources/RecordDetail';
import { ImportDialog } from '../../resources/ImportDialog';
import { FinanceModal } from './FinanceModal';
import { CostVersionRecords } from './CostVersionRecords';
import { CostSkuEditor } from './CostSkuEditor';
import { CostRecalculationDialog } from './CostRecalculationDialog';
import { costVersionsApi, downloadCostWorkbook, type SourcePreview, type RecalculationPreview, type VersionCostRow, type VersionPreview } from './costVersionsApi';
import { Pager, money } from './common';

const LABELS: Record<string,string> = {floor:'公司底价',sku:'SKU成本',auxiliary:'辅助成本',types:'辅助成本类型',production:'生产成本标准'};
const TYPES: Record<string,string> = {auxiliary:'finance-cost-auxiliary',types:'finance-cost-aux-types',production:'finance-cost-production-rates'};
const BUCKETS: Record<string,string> = {purchase:'采购成本',transfer:'调运成本',pre_ship_package:'发货前包装成本',production:'生产成本',shipping_package:'发货包装成本',express:'快递成本'};
const STATUS: Record<string,string> = {draft:'草稿',active:'已启用并锁定',inactive:'已停用'};
const errorText = (e: unknown) => (e as Error).message || '操作失败';

export function CostVersionWorkspace() {
  const {can: has} = useAuth();
  const can = useResourceCan('finance-cost-versions');
  const writable = has('product.cost.edit');
  const [versions,setVersions] = useState<ResourceDto[]>([]),[selected,setSelected] = useState<number | null>(null);
  const [section,setSection] = useState('floor'),[globalView,setGlobalView] = useState<string | null>(null);
  const [preview,setPreview] = useState<VersionPreview | null>(null),[busy,setBusy] = useState(false),[error,setError] = useState(''),[notice,setNotice] = useState('');
  const [form,setForm] = useState<{record:ResourceDto | null} | null>(null),[skuForm,setSkuForm] = useState<{record:ResourceDto | null} | null>(null),[importing,setImporting] = useState(false);
  const [copy,setCopy] = useState<ResourceDto | null>(null),[copyName,setCopyName] = useState('');
  const [activating,setActivating] = useState<ResourceDto | null>(null),[activation,setActivation] = useState<VersionPreview | null>(null),[sources,setSources] = useState<SourcePreview | null>(null);
  const [reason,setReason] = useState<{version:ResourceDto;action:'stop'|'delete'} | null>(null),[detail,setDetail] = useState<VersionCostRow | null>(null),[adjust,setAdjust] = useState<{row:VersionCostRow;type:string} | null>(null);
  const [keyword,setKeyword] = useState(''),[skuType,setSkuType] = useState(''),[page,setPage] = useState(1);
  const [deleteSku,setDeleteSku] = useState<VersionCostRow | null>(null),[clearing,setClearing] = useState(false),[clearCode,setClearCode] = useState(''),[clearReason,setClearReason] = useState('');
  const [recalculation,setRecalculation] = useState<RecalculationPreview | null>(null);
  const serial = useRef(0);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const version = versions.find(v=>v.id===selected);
  const locked = !!version?.data.lockedAt || version?.status !== 'draft';
  const loadVersions = useCallback(async()=>{
    const rows:ResourceDto[]=[];
    for(let p=1;;p++){const result=await resourceApi.list('finance-cost-versions',{page:p,pageSize:200,showHidden:true});rows.push(...result.items);if(rows.length>=result.total || !result.items.length)break;}
    setVersions(rows);
  },[]);
  const canViewVersions = can('view') && has('product.cost.view');
  useEffect(()=>{if(canViewVersions)void loadVersions().catch(e=>setError(errorText(e)));},[loadVersions,canViewVersions]);
  const loadPreview = useCallback(async()=>{
    if(selected===null || selectedRef.current!==selected)return;
    const token=++serial.current;setPreview(null);
    try{const data=await costVersionsApi.preview(selected);if(token===serial.current)setPreview(data);}catch(e){if(token===serial.current)setError(errorText(e));}
  },[selected]);
  useEffect(()=>{setKeyword('');setSkuType('');setPage(1);void loadPreview();return()=>{serial.current++;};},[loadPreview]);
  async function run(fn:()=>Promise<unknown>,message?:string){if(busy)return;setBusy(true);setError('');try{await fn();if(message)setNotice(message);await loadVersions();await loadPreview();}catch(e){setError(errorText(e));}finally{setBusy(false);}}
  const enter=(v:ResourceDto,tab='floor')=>{setSelected(v.id);setSection(tab);setGlobalView(null);setError('');};
  const featured=versions.find(v=>v.status==='active' && v.data.isDefault) ?? versions.find(v=>v.status==='active');
  const rows=(preview?.rows ?? []).filter(r=>(!skuType || r.skuType===skuType) && (!keyword.trim() || `${r.code} ${r.name}`.toLowerCase().includes(keyword.trim().toLowerCase())));
  const shown=rows.slice((page-1)*20,page*20);
  async function requestActivation(v:ResourceDto){setActivating(v);setActivation(null);setBusy(true);setError('');try{setActivation(await costVersionsApi.preview(v.id));}catch(e){setError(errorText(e));}finally{setBusy(false);}}
  const actions=(v:ResourceDto)=><div className="row-actions">
    <button type="button" className="link-button" onClick={()=>enter(v)}>公司底价</button><button type="button" className="link-button" onClick={()=>enter(v,'sku')}>SKU成本</button><button type="button" className="link-button" onClick={()=>enter(v,'auxiliary')}>辅助成本</button>
    {writable && can('create') && <button type="button" className="link-button" disabled={busy} onClick={()=>{setCopy(v);setCopyName(`${v.title}（副本）`);}}>复制</button>}
    {writable && can('edit') && <><button type="button" className="link-button" onClick={()=>setForm({record:v})}>{v.data.lockedAt?'调整日期 / 资料':'编辑'}</button>
      {v.status==='draft' && <button type="button" className="link-button" disabled={busy} onClick={()=>void requestActivation(v)}>启用并锁定</button>}
      {v.status==='inactive' && v.data.lockedAt && <button type="button" className="link-button" disabled={busy} onClick={()=>void requestActivation(v)}>恢复使用</button>}
      {v.status==='active' && !v.data.isDefault && <button type="button" className="link-button" disabled={busy} onClick={()=>void run(()=>resourceApi.update('finance-cost-versions',v.id,{isDefault:true}),'已设为默认成本版本')}>设为默认</button>}
      {v.status==='active' && <button type="button" className="link-button" onClick={()=>setReason({version:v,action:'stop'})}>停用</button>}
    </>}
    {writable && can('delete') && v.status==='draft' && <button type="button" className="link-button danger" onClick={()=>setReason({version:v,action:'delete'})}>删除</button>}
  </div>;

  if (!canViewVersions) return <p className="muted">需要成本版本和商品成本查看权限。</p>;
  return <div className="cost-version-page">
    <header className="page-head between"><div><h1>成本版本</h1><p className="muted">按成本版本维护SKU与辅助成本，预检通过后启用并锁定。</p></div><div className="row-actions"><button type="button" className="secondary-button" onClick={()=>{setGlobalView('types');setSelected(null);}}>辅助成本类型</button><button type="button" className="secondary-button" onClick={()=>{setGlobalView('production');setSelected(null);}}>生产成本标准</button><Link className="secondary-button" to="/finance/cost-table">返回SKU成本表</Link>{writable && can('create') && <button type="button" className="primary-button" onClick={()=>setForm({record:null})}>新建成本版本</button>}</div></header>
    {error && <div role="alert" className="notice error">{error}</div>}{notice && <div role="status" className="notice ok">{notice}</div>}
    {globalView ? <><button type="button" className="secondary-button" onClick={()=>setGlobalView(null)}>返回成本版本</button><CostVersionRecords key={globalView} type={TYPES[globalView]} versionId={0} locked={!writable}/></> : version ? <>
      <button type="button" className="secondary-button" onClick={()=>setSelected(null)}>返回成本版本</button>
      <section className="card"><div className="between"><div><h2>{version.title}</h2><span>{version.data.periodName ? `${String(version.data.periodName)} · `:''}{String(version.data.effectiveFrom || '立即')} 至 {String(version.data.effectiveTo || '长期')} · 默认加价率 {String(version.data.defaultMarkupPercent)}%</span></div><span className={`pill ${version.status==='active'?'ok':'warn'}`}>{STATUS[version.status]}</span></div>{actions(version)}</section>
      <nav className="tab-group" role="tablist" aria-label="成本版本内容">{Object.entries(LABELS).map(([id,label])=><button key={id} type="button" role="tab" aria-selected={section===id} className={section===id?'chip active':'chip'} onClick={()=>setSection(id)}>{label}</button>)}</nav>
      {TYPES[section] ? <CostVersionRecords key={`${selected}-${section}`} type={TYPES[section]} versionId={version.id} locked={(!['types','production'].includes(section) && locked) || !writable} onChanged={()=>void loadPreview()}/> : <section className="card">
        <div className="toolbar">
          <input type="search" aria-label="搜索版本SKU" placeholder="SKU编码 / 商品名称" value={keyword} onChange={e=>{setKeyword(e.target.value);setPage(1);}}/>
          <select aria-label="SKU类型" value={skuType} onChange={e=>{setSkuType(e.target.value);setPage(1);}}><option value="">全部SKU</option><option value="base_code">商品基础编码</option><option value="bundle">商品组合编码</option></select>
          {!locked && writable && can('create') && <button type="button" className="primary-button" onClick={()=>setSkuForm({record:null})}>选择SKU设置</button>}
          {!locked && writable && can('create') && can('edit') && <button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{setRecalculation(await costVersionsApi.recalculatePreview(version.id));})}>预检自动重算</button>}
          {!locked && writable && can('create') && <button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(async()=>setSources(await costVersionsApi.sources(version.id)))}>补齐未登记SKU</button>}
          {!locked && writable && can('import') && <button type="button" className="secondary-button" onClick={()=>setImporting(true)}>导入SKU成本</button>}
          {!locked && writable && can('delete') && <button type="button" className="secondary-button danger" disabled={busy || !preview} onClick={()=>{setClearCode('');setClearReason('');setClearing(true);}}>清空版本成本</button>}
          <button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(async()=>downloadCostWorkbook(await costVersionsApi.export(version.id)))}>导出当前版本</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={()=>void loadPreview()}>刷新</button>
        </div>
        {!locked && <p className="muted">草稿显示已保存成本；来源或辅助成本修改后，先预检自动重算，再确认更新。</p>}{locked && <p className="muted">显示启用时锁定的成本，来源商品后续修改不会覆盖此版本。</p>}
        <div className="table-scroll"><table className="data-table"><thead><tr><th>SKU类型</th><th>SKU编码 / 名称</th><th>重量（g）</th>{section==='sku' && Object.values(BUCKETS).map(label=><th key={label}>{label}</th>)}<th>发货前成本</th><th>含快递成本</th><th>加价率</th><th>公司底价</th><th>检查</th><th>操作</th></tr></thead><tbody>
          {shown.map(row=><tr key={row.settingId}><td>{row.skuType==='base_code'?'基础编码':'组合编码'}</td><td><strong>{row.code}</strong><div>{row.name}</div></td><td>{row.weightG ?? '—'}</td>{section==='sku' && Object.keys(BUCKETS).map(key=><td key={key}>{money(row.buckets[key])}</td>)}<td>{money(row.preShipCostCents)}</td><td>{money(row.costIncludingFreightCents)}</td><td>{row.markupPercent}%</td><td><strong>{money(row.minPriceCents)}</strong></td><td>{[...row.issues,...(row.warnings ?? [])].join('；') || '检查通过'}</td><td className="row-actions">
            <button type="button" className="link-button" onClick={()=>setDetail(row)}>查看</button>
            {!locked && writable && can('edit') && <><button type="button" className="link-button" onClick={()=>void run(async()=>setSkuForm({record:await resourceApi.get('finance-cost-skus',row.settingId)}))}>编辑成本</button><button type="button" className="link-button" onClick={()=>setAdjust({row,type:'finance-cost-assignments'})}>辅助成本分摊</button><button type="button" className="link-button" onClick={()=>setAdjust({row,type:'finance-cost-overrides'})}>成本调整</button></>}
            {!locked && writable && can('delete') && <button type="button" className="link-button danger" onClick={()=>setDeleteSku(row)}>删除SKU成本</button>}
          </td></tr>)}
          {preview && !rows.length && <tr><td colSpan={section==='sku'?15:9} className="empty-state muted">暂无SKU成本。选择SKU设置，或预检后补齐已验证SKU。</td></tr>}
        </tbody></table></div><Pager page={page} total={rows.length} pageSize={20} onPage={setPage}/>
      </section>}
    </> : <>
      {featured && <section className="card cost-featured-version"><h2>{featured.title}</h2><p className="muted">{featured.data.isDefault?'默认成本版本':'已启用成本版本'} · {String(featured.data.periodName || '')}</p><div className="row-actions">{['floor','sku','auxiliary'].map(tab=><button key={tab} type="button" className="secondary-button" onClick={()=>enter(featured,tab)}>{LABELS[tab]}</button>)}</div></section>}
      <section className="card"><h2>成本版本</h2><div className="table-scroll"><table className="data-table"><thead><tr><th>成本版本</th><th>期间名称</th><th>生效期间</th><th>默认加价率</th><th>状态</th><th>操作</th></tr></thead><tbody>{versions.map(v=><tr key={v.id}><td><strong>{v.title}</strong><div className="muted">{String(v.data.versionCode)}</div></td><td>{String(v.data.periodName || '—')}</td><td>{String(v.data.effectiveFrom || '立即')} 至 {String(v.data.effectiveTo || '长期')}</td><td>{String(v.data.defaultMarkupPercent)}%</td><td>{STATUS[v.status]}{v.data.isDefault===true && ' · 默认'}</td><td>{actions(v)}</td></tr>)}{!versions.length && <tr><td colSpan={6} className="empty-state muted">尚无成本版本。新建版本后维护SKU成本和辅助成本。</td></tr>}</tbody></table></div></section>
    </>}

    {form && <RecordForm def={{...getResourceDef('finance-cost-versions')!,fields:getResourceDef('finance-cost-versions')!.fields.filter(f=>!['versionCode','isDefault'].includes(f.key))}} record={form.record} initial={form.record?.data ?? {defaultMarkupPercent:20,isDefault:false}} lockedFields={form.record?.data.lockedAt?['versionCode','defaultMarkupPercent']:undefined} onClose={()=>setForm(null)} onSaved={()=>{setForm(null);void loadVersions();}}/>}
    {skuForm && version && <CostSkuEditor version={version} record={skuForm.record} onClose={()=>setSkuForm(null)} onSaved={()=>{setSkuForm(null);void loadPreview();}}/>}
    {importing && version && <ImportDialog def={getResourceDef('finance-cost-skus')!} parentId={version.id} onClose={()=>setImporting(false)} onDone={()=>{setImporting(false);void loadPreview();}}/>}
    {copy && <FinanceModal title="复制成本版本" busy={busy} onClose={()=>setCopy(null)}>{error && <div role="alert" className="notice error">{error}</div>}<form className="form-grid" onSubmit={e=>{e.preventDefault();void run(async()=>{const result=await costVersionsApi.copy(copy.id,'',copyName);setCopy(null);setSelected(result.id);setSection('sku');},'已复制为草稿，请检查成本后启用');}}><label>新版本名称<input required maxLength={200} value={copyName} onChange={e=>setCopyName(e.target.value)}/></label><button type="submit" className="primary-button" disabled={busy}>复制版本</button></form></FinanceModal>}
    {activating && <FinanceModal title={`${activating.data.lockedAt?'恢复使用':'启用并锁定'}「${activating.title}」`} busy={busy} onClose={()=>setActivating(null)}>{error && <div role="alert" className="notice error">{error}</div>}<p>启用前检查SKU成本、重量和辅助成本归集。启用后成本快照锁定，后续通过复制版本调整。</p>{activation ? <>{activation.transition && <p className="notice warn">前一默认版本「{activation.transition.name}」将截止至 {activation.transition.effectiveTo}，当前版本设为默认。</p>}<p>共 {activation.rows.length} 个SKU，{activation.issues.length} 项阻断。</p>{!!activation.warnings?.length && <details><summary>查看提醒（{activation.warnings.length}）</summary><ul>{activation.warnings.slice(0,100).map((warning,i)=><li key={i}>{warning}</li>)}</ul></details>}{activation.issues.length>0 && <ul>{activation.issues.slice(0,30).map((issue,i)=><li key={i} className="bad-text">{issue}</li>)}</ul>}<button type="button" className="primary-button" disabled={busy || !activation.ready} onClick={()=>void run(async()=>{await costVersionsApi.activate(activating.id,activation.activationSignature ?? activation.signature);setActivating(null);},'成本版本已启用并锁定')}>{activation.ready?(activating.data.lockedAt?'确认恢复使用':'确认启用并锁定'):'请先处理阻断项'}</button></> : <p>正在预检…</p>}</FinanceModal>}
    {sources && version && <FinanceModal title="补齐未登记SKU预检" busy={busy} onClose={()=>setSources(null)}>{error && <div role="alert" className="notice error">{error}</div>}<p>发现 {sources.rows.length} 个尚未登记的已验证SKU。确认后加入当前草稿；已维护的手工成本与调整保留。</p><ul>{sources.rows.slice(0,50).map(r=><li key={`${r.skuType}-${r.skuId}`}>{r.code} · {r.name}</li>)}</ul><button type="button" className="primary-button" disabled={busy || !sources.rows.length} onClick={()=>void run(async()=>{const result=await costVersionsApi.register(version.id,sources.signature);setSources(null);setNotice(`已补齐 ${result.created} 个SKU，初始成本按当前来源填写`);})}>确认补齐SKU</button></FinanceModal>}
    {detail && <FinanceModal title={`SKU成本明细 · ${detail.code}`} onClose={()=>setDetail(null)}><h3>{detail.name}</h3><table className="data-table"><tbody>{Object.entries(BUCKETS).map(([key,label])=><tr key={key}><th>{label}</th><td>{money(detail.buckets[key])}</td></tr>)}<tr><th>公司底价</th><td>{money(detail.minPriceCents)}</td></tr></tbody></table>{!!detail.warnings?.length && <ul>{detail.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul>}<h3>商品组成</h3><ul>{detail.lines.map((line,i)=><li key={i}>{line.code} · {line.name} × {line.qty}：{money(line.subtotalCents)}</li>)}</ul></FinanceModal>}
    {deleteSku && <ReasonDialog title={`删除SKU成本「${deleteSku.name}」`} hint="有辅助分摊或成本调整引用时，请先解除引用。" danger confirmLabel="确认删除" onClose={()=>setDeleteSku(null)} onConfirm={async reason=>{await resourceApi.remove('finance-cost-skus',deleteSku.settingId,reason);setDeleteSku(null);await loadPreview();}}/>}
    {clearing && version && preview && <FinanceModal title="清空版本成本" busy={busy} onClose={()=>setClearing(false)}>{error && <div role="alert" className="notice error">{error}</div>}<p>清空「{version.title}」草稿下的SKU、辅助成本、分摊与调整；版本、辅助类型和生产标准保留。</p><form className="form-grid" onSubmit={e=>{e.preventDefault();void run(async()=>{const result=await costVersionsApi.clear(version.id,preview.signature,clearCode,clearReason);setClearing(false);setNotice(`已清空 ${result.deleted} 条版本成本资料`);});}}><label>输入版本编号 {String(version.data.versionCode)}<input aria-label="清空版本确认编号" value={clearCode} onChange={e=>setClearCode(e.target.value)}/></label><label>清空原因<input required minLength={2} maxLength={500} value={clearReason} onChange={e=>setClearReason(e.target.value)}/></label><button type="submit" className="primary-button danger" disabled={busy || clearCode!==version.data.versionCode || clearReason.trim().length<2}>确认清空草稿成本</button></form></FinanceModal>}
    {adjust && version && <FinanceModal title={`${adjust.row.name} · ${getResourceDef(adjust.type)!.label}`} onClose={()=>setAdjust(null)}><CostVersionRecords type={adjust.type} versionId={version.id} skuSettingId={adjust.row.settingId} locked={(!['types','production'].includes(section) && locked) || !writable} onChanged={()=>void loadPreview()}/></FinanceModal>}
    {recalculation && version && <CostRecalculationDialog preview={recalculation} busy={busy} error={error} onClose={()=>setRecalculation(null)} onConfirm={()=>void run(async()=>{const result=await costVersionsApi.recalculate(version.id,recalculation.signature);setRecalculation(null);setNotice(`成本重算完成：更新 ${result.updated} 个SKU，首次登记 ${result.created} 个SKU`);})}/>}
    {reason && <ReasonDialog title={`${reason.action==='stop'?'停用':'删除'}成本版本「${reason.version.title}」`} hint={reason.action==='stop'?'停用后此版本不再参与业务日期匹配，已锁定成本仍然保留。':'版本下有成本明细时不能删除，请先处理草稿明细。'} danger confirmLabel="确认" onClose={()=>setReason(null)} onConfirm={async text=>{if(reason.action==='stop')await resourceApi.changeStatus('finance-cost-versions',reason.version.id,'inactive',text);else await resourceApi.remove('finance-cost-versions',reason.version.id,text);setReason(null);await loadVersions();}}/>}
  </div>;
}
