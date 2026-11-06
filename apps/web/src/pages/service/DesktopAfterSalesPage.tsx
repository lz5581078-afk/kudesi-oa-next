import { useEffect, useRef, useState, useCallback } from 'react';
import {
 AFTER_SALES_MAX_FILTERS, AFTER_SALES_PAGE_SIZE, AFTER_SALES_PRIORITIES as PRIORITIES, DESKTOP_AFTER_SALES_SOURCE_LINK, afterSalesCell,
 type AfterSalesColumn, type AfterSalesColumnFilter, type DesktopSaleArchive, type DesktopSaleSnapshot, type DesktopSaleListRow,
} from '@kudesi/shared';
import { ExternalLink, Search, X } from 'lucide-react';
import { AfterSalesTableHead, ColumnPicker, moveColumn, readColumns, writeColumns, type AfterSalesSort } from './DesktopAfterSalesColumns';
import { DesktopCollectionStatus } from './DesktopCollectionStatus';
import { RunDetail } from '../flow/RunDetail';
import { api, tokenStore } from '../../api/client';
import './desktopBridge';
import './desktopAfterSales.css';

type Options={stores:Array<{id:number;name:string}>;people:Array<{id:number;name:string}>};
type List={total:number;rows:DesktopSaleListRow[]};
const BASE='/desktop-after-sales';
const localDate=(value:string|null)=>{if(!value)return '';const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const errorMessage=(error:unknown)=>String((error as Error).message||error).replace(/^Error invoking remote method .*?Error: /,'');

export function DesktopAfterSalesPage(){
 const desktop=window.oaDesktop;
 const bridge=desktop?.surface==='main'?undefined:desktop;
 const lookup=desktop?.surface==='main'&&!desktop.openSourceWindow?undefined:desktop;
 const viewport=useRef<HTMLDivElement>(null),selectedRef=useRef<DesktopSaleArchive|null>(null),request=useRef(0),listRequest=useRef(0);
 const [options,setOptions]=useState<Options>({stores:[],people:[]}),[list,setList]=useState<List>({total:0,rows:[]});
 const [selected,setSelected]=useState<DesktopSaleArchive|null>(null),[sourceStatus,setSourceStatus]=useState<{text:string;error?:boolean}|null>(null);
 const [storeId,setStoreId]=useState(''),[search,setSearch]=useState(''),[keyword,setKeyword]=useState(''),[page,setPage]=useState(1);
 const [progress,setProgress]=useState(''),[owner,setOwner]=useState(''),[nextAt,setNextAt]=useState(''),[note,setNote]=useState('');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[tab,setTab]=useState<'follow'|'source'>('follow');
 const [portal,setPortal]=useState(false),[columns,setColumns]=useState<AfterSalesColumn[]>(readColumns),[showColumns,setShowColumns]=useState(false);
 const [sort,setSort]=useState<AfterSalesSort>({key:'申请时间',direction:'desc'}),[filters,setFilters]=useState<AfterSalesColumnFilter[]>([]);
 const [filterColumn,setFilterColumn]=useState<AfterSalesColumn|null>(null),[filterText,setFilterText]=useState('');
 const [priority,setPriority]=useState(0),[rowColor,setRowColor]=useState(''),[report,setReport]=useState(''),[recipient,setRecipient]=useState(''),[message,setMessage]=useState('');
 const [flowId,setFlowId]=useState<number|null>(null),[caseType,setCaseType]=useState('other'),[flowAmount,setFlowAmount]=useState('0'),[flowReason,setFlowReason]=useState('');
 const metadataDirty=useRef(false),dirty=useRef(false),draftVersion=useRef(0);

 const loadList=useCallback(async(p=page)=>{
  const seq=++listRequest.current;
  const query={keyword,page:p,sort:sort.key,direction:sort.direction};
  const value=filters.length
   ? await api<List>(BASE+'/search',{body:{...query,filters}})
   : await api<List>(BASE+'?'+new URLSearchParams({...query,page:String(p)}));
  if(seq===listRequest.current)setList(value);
 },[page,keyword,sort,filters]);
 useEffect(()=>{
  let active=true;
  void loadList().catch(e=>{if(active)setError(errorMessage(e));});
  const timer=setInterval(()=>{if(active)void loadList().catch(()=>undefined);},filters.length?30000:5000);
  return()=>{active=false;clearInterval(timer);listRequest.current++;};
 },[loadList,filters.length]);
 useEffect(()=>{
  let active=true;
  void api<Options>(BASE+'/options').then(v=>{if(active)setOptions(v);}).catch(e=>{if(active)setError(errorMessage(e));});
  return()=>{active=false;request.current++;};
 },[]);

 const accept=(v:DesktopSaleArchive)=>{draftVersion.current=v.version;selectedRef.current=v;setSelected(v);setProgress(v.progress);setOwner(v.ownerId?String(v.ownerId):'');setNextAt(localDate(v.nextAt));dirty.current=false;metadataDirty.current=false;setNote('');setPriority(v.priority??0);setRowColor(v.rowColor??'');setReport(v.report??'');};
 const acceptAttachment=(v:DesktopSaleArchive)=>{
  const current=selectedRef.current;if(!current||current.id!==v.id||v.version<current.version)return;
  if(!dirty.current){accept(v);return;}
  if(v.version===current.version){selectedRef.current=v;setSelected(v);return;}
  const sameFollow=current.progress===v.progress&&current.ownerId===v.ownerId&&current.nextAt===v.nextAt;
  if(draftVersion.current===current.version&&v.version===current.version+1&&sameFollow&&current.priority===v.priority&&current.rowColor===v.rowColor&&current.report===v.report)draftVersion.current=v.version;
  else setError('档案被其他人更新，请点击刷新版本核对处理进度，本次记录会保留。');
  selectedRef.current=v;setSelected(v);
 };
 async function run(action:()=>Promise<void>){setBusy(true);setError('');try{await action();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}

 const querySource=async(record:DesktopSaleArchive)=>{
  if(!lookup?.query)return;
  const {afterSaleId,internalOrderId,sourceCompany}=record.snapshot;
  const query={field:'afterSaleId' as const,value:afterSaleId,sourceCompany,page:1};
  const match=(records:DesktopSaleSnapshot[])=>records.find(s=>s.afterSaleId===afterSaleId&&s.sourceCompany===sourceCompany&&
    (!internalOrderId||!s.internalOrderId||s.internalOrderId===internalOrderId));
  const current=await lookup.query({...query,kind:'current'});
  const result=match(current.records)??match((await lookup.query({...query,kind:'history'})).records);
  if(!result)throw new Error('聚水潭当前和历史列表未找到这笔售后');
  return result;
 };
 const select=async(id:number)=>{
  if(dirty.current&&!confirm('当前有未保存的跟进内容，确定切换售后吗？'))return;
  const sequence=++request.current,identity=tokenStore.get();
  const active=()=>sequence===request.current&&tokenStore.get()===identity;
  await run(async()=>{
   const record=await api<DesktopSaleArchive>(BASE+'/'+id);if(!active())return;
   setTab('follow');setStoreId('');accept(record);
   setSourceStatus(null);
   if(!lookup?.query)return;
   setSourceStatus({text:'正在查询聚水潭最新状态…'});
   try{
    const snapshot=await querySource(record);if(!active()||!snapshot)return;
    const updated=await api<DesktopSaleArchive>(BASE+'/'+id+'/source',{body:snapshot});
   if(active()){acceptAttachment(updated);setSourceStatus({text:'聚水潭最新状态已归档'});}
   }catch(e){
    if(active())setSourceStatus({text:'聚水潭状态暂未更新 · '+errorMessage(e),error:true});
   }
  });
 };

 useEffect(()=>{
  if(!bridge||!portal||!viewport.current)return;
  const el=viewport.current;
  let active=true;
  const mount=()=>{const r=el.getBoundingClientRect();return bridge.mount({x:r.x,y:r.y,width:r.width,height:r.height});};
  const showError=(e:unknown)=>{if(active)setError(errorMessage(e));};
  const sync=()=>{void mount().catch(showError);};
  const observer=new ResizeObserver(sync);observer.observe(el);window.addEventListener('resize',sync);
  void mount().then(()=>active?bridge.openSourceAfterSales?.():undefined).catch(showError);
  return()=>{active=false;observer.disconnect();window.removeEventListener('resize',sync);void bridge.hide().catch(()=>undefined);};
 },[bridge,portal]);
 useEffect(()=>()=>{void bridge?.context(null).catch(()=>undefined);},[bridge]);
 useEffect(()=>{void bridge?.context(selected?{id:selected.id,afterSaleId:selected.snapshot.afterSaleId}:null).catch(()=>undefined);},[bridge,selected?.id]);
 useEffect(()=>{if(!bridge)return;return bridge.onScreenshot(s=>{
  const current=selectedRef.current;
  if(!current||s.id!==current.id||s.afterSaleId!==current.snapshot.afterSaleId){setError('截图对应的售后已切换，未上传。截图已复制，可在对应档案手动粘贴。');return;}
  void run(async()=>{const blob=await(await fetch(s.image)).blob();const form=new FormData();form.append('file',blob,`售后-${s.afterSaleId}-${Date.now()}.png`);
   const v=await api<DesktopSaleArchive>(`${BASE}/${s.id}/files`,{method:'POST',form});
   acceptAttachment(v);await loadList();
  });
 });},[bridge,loadList]);
 const save=()=>run(async()=>{if(!selected)return;
  const v=await api<DesktopSaleArchive>(`${BASE}/${selected.id}/follow`,{method:'POST',body:{version:draftVersion.current,progress,ownerId:owner?Number(owner):null,nextAt:nextAt?new Date(nextAt).toISOString():null,note}});const pending=metadataDirty.current?{priority,rowColor,report}:null;accept(v);if(pending){setPriority(pending.priority);setRowColor(pending.rowColor);setReport(pending.report);metadataDirty.current=true;dirty.current=true;}await loadList();
 });
 const upload=(file:File)=>run(async()=>{if(!selected)return;const id=selected.id;const form=new FormData();form.append('file',file);const v=await api<DesktopSaleArchive>(`${BASE}/${id}/files`,{method:'POST',form});acceptAttachment(v);});
 const readOrder=async(record=selected)=>{
  if(!record||!bridge)return;
  if(bridge.query)await querySource(record);
  await bridge.openOrder(record.snapshot.internalOrderId);
  if(bridge.query){
   for(let i=0;i<30;i++){
    await new Promise(r=>setTimeout(r,400));
    const found=(await bridge.read()).find(s=>s.afterSaleId===record.snapshot.afterSaleId&&s.fields['订单操作日志']);
    if(found){acceptAttachment(await api<DesktopSaleArchive>(`${BASE}/${record.id}/source`,{body:found}));setTab('source');return;}
   }
   throw new Error('聚水潭订单详情尚未读完，请重试');
  }
 };
 const changeColumns=(values:AfterSalesColumn[])=>{setColumns(values);writeColumns(values);};
 const changeFilters=(values:AfterSalesColumnFilter[])=>{setFilters(values);setPage(1);};
 const openFilter=(column:AfterSalesColumn)=>{setFilterColumn(column);setFilterText(filters.find(f=>f.column===column)?.value??'');};
 const applyFilter=(value:string)=>{
  if(!filterColumn)return;
  const next=filters.filter(f=>f.column!==filterColumn);
  if(value&&next.length>=AFTER_SALES_MAX_FILTERS){setError(`最多同时筛选 ${AFTER_SALES_MAX_FILTERS} 列`);return;}
  changeFilters(value?[...next,{column:filterColumn,value}]:next);setFilterColumn(null);
 };
 const sourceButton=<><ExternalLink size={15}/> 打开聚水潭售后页面</>;
 return <div className="desktop-sales">
  <header><h2>实时售后处理</h2></header>
  <section className="ds-list-tools" aria-label="售后功能区">
   <form className="ds-search" onSubmit={e=>{e.preventDefault();const value=search.trim();if(value===keyword&&page===1)void loadList(1).catch(e=>setError(errorMessage(e)));else{setKeyword(value);setPage(1);}}}>
    <input aria-label="搜索售后单号或内部订单号" placeholder="售后单号 / 内部订单号" value={search} maxLength={80} onChange={e=>setSearch(e.target.value)}/>
    <button type="submit"><Search size={14}/> 搜索</button>
   </form>
   <button type="button" aria-expanded={showColumns} onClick={()=>setShowColumns(v=>!v)}>显示列</button>
   {desktop?.openSourceWindow
    ? <button type="button" className="ds-source-link" onClick={()=>void desktop.openSourceWindow!().catch(e=>setError(errorMessage(e)))}>{sourceButton}</button>
    : bridge
     ? <button type="button" className="ds-source-link" onClick={()=>setPortal(true)}>{sourceButton}</button>
     : <a className="ds-source-link" href={DESKTOP_AFTER_SALES_SOURCE_LINK}>{sourceButton}</a>}
  </section>
  <DesktopCollectionStatus/>
  {error&&<div role="alert" className="ds-error">{error}<button onClick={()=>setError('')}>关闭</button></div>}
  {showColumns&&<ColumnPicker columns={columns} onChange={changeColumns}/>}
  {filterColumn&&<form className="ds-filter-form ds-actions" onSubmit={e=>{e.preventDefault();applyFilter(filterText.trim());}} onKeyDown={e=>{if(e.key==='Escape')setFilterColumn(null);}}>
   <label>{filterColumn}<input autoFocus aria-label={`${filterColumn}包含`} placeholder="包含的文字" maxLength={120} value={filterText} onChange={e=>setFilterText(e.target.value)}/></label>
   <button type="submit">筛选</button><button type="button" onClick={()=>applyFilter('')}>清除此列</button><button type="button" onClick={()=>setFilterColumn(null)}>取消</button>
  </form>}
  {filters.length>0&&<div className="ds-actions ds-filter-tags" aria-label="生效中的筛选">
   {filters.map(f=><button type="button" key={f.column} aria-label={`移除${f.column}筛选`} onClick={()=>changeFilters(filters.filter(v=>v!==f))}>{f.column} · {f.value}<X size={13}/></button>)}
   <button type="button" onClick={()=>changeFilters([])}>清空筛选</button>
  </div>}
  <div className="ds-table-wrap">
   <table className="ds-table">
    <AfterSalesTableHead columns={columns} filters={filters} sort={sort} onSort={value=>{setSort(value);setPage(1);}}
      onFilter={openFilter} onMove={(from,to)=>changeColumns(moveColumn(columns,from,to))}/>
    <tbody>{list.rows.map((r,i)=><tr key={r.id} style={{backgroundColor:r.rowColor||undefined}}>
     <td>{(page-1)*AFTER_SALES_PAGE_SIZE+i+1}</td>
     {columns.map(k=><td key={k}>{k==='售后单号'
      ? <button className="ds-link" disabled={busy} onClick={()=>void select(r.id)}>{r.afterSaleId}</button>
      : k==='紧急度'
       ? <span className={`ds-urgency ds-urgency-${r.priority??0}`}>{afterSalesCell(r,k)}</span>
       : <span>{afterSalesCell(r,k)||'—'}</span>}</td>)}
     <td><button disabled={busy} onClick={()=>void select(r.id)}>处理</button></td>
    </tr>)}</tbody>
   </table>
   {!list.rows.length&&<div className="ds-empty">暂无匹配的售后记录</div>}
  </div>
  <footer className="ds-pagination"><span>共 {list.total} 条</span>
   <button disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button><span>{page} / {Math.max(1,Math.ceil(list.total/AFTER_SALES_PAGE_SIZE))}</span>
   <button disabled={page*AFTER_SALES_PAGE_SIZE>=list.total} onClick={()=>setPage(page+1)}>下一页</button>
  </footer>
    {selected&&<div className="ds-drawer-backdrop"><section className="ds-detail ds-drawer" role="dialog" aria-modal="true" aria-label={`售后 ${selected.snapshot.afterSaleId}`}><button disabled={busy} className="ds-close" aria-label="关闭售后详情" onClick={()=>{if(!dirty.current||confirm('放弃未保存的跟进内容？')){setSelected(null);selectedRef.current=null;}}}><X size={18}/></button><h3>售后 {selected.snapshot.afterSaleId}</h3><p>{selected.storeName || selected.snapshot.fields['店铺']} · 内部订单 <button className="ds-link" disabled={!bridge||!selected.snapshot.internalOrderId} onClick={()=>run(async()=>{await readOrder();})}>{selected.snapshot.internalOrderId||'待聚水潭补齐'}</button></p>
     {sourceStatus&&<p role={sourceStatus.error?'alert':'status'}>{sourceStatus.text}</p>}
     <div className="ds-tabs"><button className={tab==='follow'?'chosen':''} onClick={()=>setTab('follow')}>OA 处理记录</button><button className={tab==='source'?'chosen':''} onClick={()=>setTab('source')}>聚水潭原始信息</button></div>
     {tab==='source'?<><p>来源：{selected.snapshot.sourceCompany} · 读取于 {new Date(selected.snapshot.capturedAt).toLocaleString()}</p><dl>{Object.entries(selected.snapshot.fields).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v||'—'}</dd></div>)}</dl></>:<>
      <label>处理到哪一步<input disabled={busy} maxLength={300} value={progress} onChange={e=>{dirty.current=true;setProgress(e.target.value);}} placeholder="例如：已联系买家，等待退回物流"/></label>
      <div className="ds-columns"><label>负责人<select disabled={busy} value={owner} onChange={e=>{dirty.current=true;setOwner(e.target.value);}}><option value="">未分配</option>{options.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>下次跟进时间<input disabled={busy} type="datetime-local" value={nextAt} onChange={e=>{dirty.current=true;setNextAt(e.target.value);}}/></label></div>
      <label>本次处理记录<textarea disabled={busy} value={note} maxLength={4000} onChange={e=>{dirty.current=true;setNote(e.target.value);}} placeholder="记录已做的处理、结果和下一步" rows={3}/></label>
      <div className="ds-actions"><button className="primary" disabled={busy||!note.trim()} onClick={save}>保存跟进</button><label className="ds-upload">上传凭证<input disabled={busy} type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" onChange={e=>{const f=e.target.files?.[0];if(f)void upload(f);e.target.value='';}}/></label><button disabled={busy} onClick={()=>run(async()=>{if(dirty.current&&!confirm('刷新会重载处理进度、颜色及报告，保留本次处理记录。继续吗？'))return;const v=await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}`);const pendingNote=note;accept(v);setNote(pendingNote);dirty.current=!!pendingNote;})}>刷新版本</button></div>
      <details className="ds-tools"><summary>颜色、紧急度与跟踪报告</summary>
       <div className="ds-columns"><label>紧急度<select disabled={busy} value={priority} onChange={e=>{dirty.current=true;metadataDirty.current=true;setPriority(Number(e.target.value));}}>{PRIORITIES.map((v,i)=><option key={v} value={i}>{v}</option>)}</select></label><label>列表标记颜色<input disabled={busy} type="color" value={rowColor||'#ffffff'} onChange={e=>{dirty.current=true;metadataDirty.current=true;setRowColor(e.target.value);}}/></label></div><button onClick={()=>{dirty.current=true;metadataDirty.current=true;setRowColor('');}}>清除颜色</button>
       <label>跟踪报告<textarea disabled={busy} rows={5} maxLength={8000} value={report} onChange={e=>{dirty.current=true;metadataDirty.current=true;setReport(e.target.value);}} placeholder="事件经过、当前结果、待处理事项和结论"/></label><button disabled={busy} onClick={()=>run(async()=>{const v=await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}/metadata`,{body:{version:draftVersion.current,priority,rowColor:rowColor||null,report}});selectedRef.current=v;setSelected(v);draftVersion.current=v.version;metadataDirty.current=false;dirty.current=!!note.trim()||progress!==v.progress||owner!==(v.ownerId?String(v.ownerId):'')||nextAt!==localDate(v.nextAt);await loadList();})}>保存标记与报告</button>
      </details>
      <details className="ds-tools"><summary>推送给其他部门继续处理</summary><label>协作人<select disabled={busy} value={recipient} onChange={e=>setRecipient(e.target.value)}><option value="">选择本公司人员</option>{options.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>交接说明<textarea disabled={busy} rows={3} maxLength={500} value={message} onChange={e=>setMessage(e.target.value)}/></label><button disabled={busy||!recipient||!message.trim()} onClick={()=>run(async()=>{await api(`/desktop-after-sales-shared/${selected.id}/share`,{body:{recipients:[Number(recipient)],message,canWrite:true}});setMessage('');acceptAttachment(await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}`));})}>推送售后并授权填写处理记录</button></details>
      <details className="ds-tools"><summary>按 OA 流程逐步办理</summary>{selected.flowRunId?<button onClick={()=>setFlowId(selected.flowRunId!)}>查看办理流程</button>:<><p>关联 OA 店铺后，可按公司已发布的售后流程办理，办理人和可执行操作由流程决定。</p><label>关联 OA 店铺<select value={storeId||selected.storeId||''} onChange={e=>setStoreId(e.target.value)}><option value="">请选择</option>{options.stores.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>售后类型<select value={caseType} onChange={e=>setCaseType(e.target.value)}>{[['other','其他'],['refund_only','仅退款'],['return_refund','退货退款'],['exchange','换货'],['resend','补发'],['compensation','补偿']].map(([v,n])=><option key={v} value={v}>{n}</option>)}</select></label><label>申请金额（元）<input type="number" min="0" step="0.01" value={flowAmount} onChange={e=>setFlowAmount(e.target.value)}/></label><label>流程申请说明<textarea maxLength={500} value={flowReason} onChange={e=>setFlowReason(e.target.value)}/></label><button disabled={busy||!flowReason.trim()} onClick={()=>run(async()=>{if(!selected.storeId){if(!storeId)throw new Error('请关联 OA 店铺');await api('/desktop-after-sales/import',{body:{storeId:Number(storeId),snapshot:selected.snapshot}});}const result=await api<{runId:number}>(`/desktop-after-sales-shared/${selected.id}/flow`,{body:{caseType,amountCents:Math.round(Number(flowAmount)*100),reason:flowReason}});setFlowId(result.runId);acceptAttachment(await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}`));})}>发起办理流程</button></>}</details>
      {selected.files.map(f=><button key={f.id} className="ds-file" onClick={()=>run(async()=>{const v=await api<{url:string}>(`/desktop-after-sales/${selected.id}/files/${f.id}/url`);window.open(v.url,'_blank','noopener');})}>{f.name}</button>)}
      <ol className="ds-history">{selected.events.map(e=><li key={e.id}><small>{e.actorName} · {new Date(e.createdAt).toLocaleString()}</small><p>{e.content}</p></li>)}</ol>{selected.nextEventsBefore&&<button disabled={busy} onClick={()=>run(async()=>{const value=await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}/events?before=${selected.nextEventsBefore}`);const current=selectedRef.current;if(current?.id===selected.id){const next={...current,events:[...current.events,...value.events],nextEventsBefore:value.nextEventsBefore};selectedRef.current=next;setSelected(next);}})}>加载更早处理历史</button>}
     </>}
    </section></div>}

  {portal&&bridge&&<div className="ds-native-overlay"><div className="ds-native-title"><strong>聚水潭售后</strong><span/>
   <button type="button" onClick={()=>void bridge.refresh().catch(e=>setError(errorMessage(e)))}>刷新聚水潭</button>
   <button type="button" onClick={()=>setPortal(false)}>关闭原页面</button>
  </div><div className="ds-viewport" ref={viewport}/></div>}
  {flowId&&<div className="ds-flow"><RunDetail id={flowId} onClose={()=>setFlowId(null)} onChanged={()=>{if(selected)void run(async()=>acceptAttachment(await api<DesktopSaleArchive>(`${BASE}/${selected.id}`)));}}/></div>}
 </div>;
}
