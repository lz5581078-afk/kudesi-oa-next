import { useEffect, useRef, useState, useCallback } from 'react';
import {
 AFTER_SALES_MAX_FILTERS, AFTER_SALES_PAGE_SIZE, DESKTOP_AFTER_SALES_SOURCE_LINK,
 JST_AFTER_SALES_COLUMNS, JST_AFTER_SALES_ORIGINAL_COLUMNS, afterSalesCell,
 type AfterSalesColumn, type AfterSalesColumnFilter, type AfterSalesWidthColumn, type JstAfterSalesOriginalColumn, type DesktopSaleArchive, type DesktopSaleSnapshot, type DesktopSaleListRow, type DesktopSaleWorkspaceState, type DesktopSaleClick, type DesktopSaleEvent,
} from '@kudesi/shared';
import { Camera, CircleCheck, Copy, Download, ExternalLink, Flag, Pencil, Search, Video, X } from 'lucide-react';
import { AfterSalesTableHead, ColumnPicker, defaultAfterSalesColumnWidth, moveColumn, type AfterSalesSort } from './DesktopAfterSalesColumns';
import {useAfterSalesColumns} from './useAfterSalesColumns';
import { DesktopCollectionStatus } from './DesktopCollectionStatus';
import { DesktopAfterSalesAcceptance } from './DesktopAfterSalesAcceptance';
import { DesktopJushuitanStatus, useJushuitanStatus } from './DesktopJushuitanStatus';
import { DesktopAfterSalesOrder, DesktopAfterSalesSale, INTERNAL_ORDER_FIELDS } from './DesktopAfterSalesOrder';
import { DesktopAfterSalesLogistics, DesktopAfterSalesSourcePanel, SOURCE_PANELS } from './DesktopAfterSalesSourcePanel';
import {AfterSalesProductImage} from './AfterSalesProductImage';
import { DesktopAfterSalesPopup } from './DesktopAfterSalesPopup';
import { AfterSalesEvidence, DesktopAfterSalesHistory } from './DesktopAfterSalesHistory';
import { api, tokenStore } from '../../api/client';
import type { DesktopSourcePanel, RecordingIdentity, RecordingStatus } from './desktopBridge';
import './desktopAfterSales.css';

type Options={people:Array<{id:number;name:string;departmentId?:number|null;departmentName?:string|null}>;currentUserId?:number;currentDepartmentId?:number|null};
type List={total:number;rows:DesktopSaleListRow[]};
const BASE='/desktop-after-sales';
const recordingKey=({sourceCompany,afterSaleId}:RecordingIdentity)=>JSON.stringify([sourceCompany,afterSaleId]);
const SOURCE_CELL_PANELS:Partial<Record<AfterSalesColumn,DesktopSourcePanel>>={
 商品信息:'goods',实退金额:'refund',
};
const SOURCE_PANEL_COLUMNS:Record<DesktopSourcePanel,JstAfterSalesOriginalColumn>={
 goods:'商品信息',refund:'实退金额',logs:'操作',tracking:'退货快递单号',shipping:'发货快递单号',platform:'平台售后详情',
 orderAmount:'原订单下单金额',refusal:'拒绝原因',
};
const SOURCE_FIELD_LINKS=new Set<string>(JST_AFTER_SALES_ORIGINAL_COLUMNS);
const SOURCE_EDIT_FIELDS=new Set<AfterSalesColumn>(['原订单备注/旗帜','原订单线下备注','售后标签','售后问题登记','退货快递单号']);
const safeColor=(value?:string)=>value&&/^#[0-9a-f]{6}$/.test(value)?value:undefined;
const SOURCE_COPY_FIELDS=new Set<AfterSalesColumn>([
 '售后单号','内部订单号','店铺','线上订单号','线上售后单号','收货仓','拦截失败原因','退款原因',
]);
function hasOriginalField(column:AfterSalesColumn): column is AfterSalesColumn & JstAfterSalesOriginalColumn {
 return SOURCE_FIELD_LINKS.has(column);
}
const localDate=(value:string|null)=>{if(!value)return '';const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const sourceTimeFormat=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'medium',hour12:false});
const formatSourceTime=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?'未知':sourceTimeFormat.format(date);};
const errorMessage=(error:unknown)=>String((error as Error).message||error).replace(/^Error invoking remote method .*?Error: /,'');

function GoodsPreview({value,images=[]}:{value:string;images?:string[]}){
 const lines=value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
 const items:Array<{name:string;spec:string;kind:string;quantity:string}>=[];
 let start=0;
 for(const [index,line] of lines.entries()){
  if(!/^[x×]\s*\d+/i.test(line))continue;
  const parts=lines.slice(start,index);
  start=index+1;
  const kind=/^[退其换]$/.test(parts.at(-1)??'')?parts.pop()!:'';
  if(parts[0])items.push({name:parts[0],spec:parts.slice(1).join(' '),kind,quantity:line});
 }
 if(!items.length)return <span className="ds-cell-value" title={value||undefined}>{value||'—'}</span>;
 return <div className="ds-goods-preview" title={value}>{items.slice(0,2).map((item,index)=><div key={index}>
  {images[index]&&<AfterSalesProductImage src={images[index]}/>}
  <div className="ds-goods-preview-text"><span>{item.name}</span>{item.spec&&<span>{item.spec}</span>}</div>
  {item.kind&&<span className="ds-goods-kind">{item.kind}</span>}<span className="ds-goods-quantity">{item.quantity}</span>
 </div>)}</div>;
}

export function DesktopAfterSalesPage(){
 const desktop=window.oaDesktop;
 const bridge=desktop?.surface==='main'?undefined:desktop;
 const lookup=desktop?.surface==='main'&&!desktop.openSourceWindow?undefined:desktop;
 const login=useJushuitanStatus(lookup);
 const viewport=useRef<HTMLDivElement>(null),selectedRef=useRef<DesktopSaleArchive|null>(null),request=useRef(0),listRequest=useRef(0);
 const [options,setOptions]=useState<Options>({people:[]}),[list,setList]=useState<List>({total:0,rows:[]});
 const [selected,setSelected]=useState<DesktopSaleArchive|null>(null),[sourceStatus,setSourceStatus]=useState<{text:string;error?:boolean}|null>(null);
 const [search,setSearch]=useState(''),[keyword,setKeyword]=useState(''),[page,setPage]=useState(1);
 const [owner,setOwner]=useState(''),[nextAt,setNextAt]=useState(''),[note,setNote]=useState('');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[sourceLoading,setSourceLoading]=useState(false),[tab,setTab]=useState<'follow'|'changes'|'source'|'order'>('follow');
 const [closeReason,setCloseReason]=useState<string|null>(null);
 const [captureStatus,setCaptureStatus]=useState<{id:number;text:string;pending:boolean}|null>(null);
 const captureRequest=useRef<{id:number;afterSaleId:string;identity:string|null}|null>(null);
 const [sourcePanel,setSourcePanel]=useState<DesktopSourcePanel|null>(null);
 const [documentImages,setDocumentImages]=useState<{key:string;kind:'sale'|'order';table:string;images:string[]}|null>(null);
 const [panelPreview,setPanelPreview]=useState<{kind:DesktopSourcePanel;snapshot:DesktopSaleSnapshot;anchor:HTMLButtonElement|null}|null>(null);
 const [popupAnchor,setPopupAnchor]=useState<HTMLButtonElement|null>(null);
 const panelReturnTab=useRef<'source'|'changes'|null>(null);
 const documentReturnTab=useRef<'follow'|'changes'|null>(null);
 const [copyStatus,setCopyStatus]=useState('');
 const [recordings,setRecordings]=useState<Record<string,RecordingStatus['state']>>({});
 const [goodsImages,setGoodsImages]=useState<Record<string,string[]>>({});
 const {columns,widths,changeColumns,changeWidth,resetWidths,retry,failed:columnsFailed}=useAfterSalesColumns();
 const tableColumns:AfterSalesWidthColumn[]=['序号',...columns,'操作'];
 const columnWidth=(column:AfterSalesWidthColumn)=>widths[column]??defaultAfterSalesColumnWidth(column);
 const tableWidth=tableColumns.reduce((sum,column)=>sum+columnWidth(column),0);
 const [portal,setPortal]=useState<'source'|'video'|'assistant-video'|null>(null),[showColumns,setShowColumns]=useState(false);
 const [videoFallback,setVideoFallback]=useState<{identity:RecordingIdentity;id:number}|null>(null);
 const [listMode,setListMode]=useState<DesktopSaleWorkspaceState>('open');
 const [sort,setSort]=useState<AfterSalesSort>({key:'申请时间',direction:'desc'}),[filters,setFilters]=useState<AfterSalesColumnFilter[]>([]);
 const [filterColumn,setFilterColumn]=useState<AfterSalesColumn|null>(null),[filterText,setFilterText]=useState('');
 const [notifyOpen,setNotifyOpen]=useState(false);
 const [personSearch,setPersonSearch]=useState(''),[browsePeople,setBrowsePeople]=useState(false);
 const [departmentFilter,setDepartmentFilter]=useState('');
 const [actionStatus,setActionStatus]=useState('');
 const [recipient,setRecipient]=useState(''),[message,setMessage]=useState('');
 const [evidencePreview,setEvidencePreview]=useState<{url:string;name:string}|null>(null);
 const dirty=useRef(false),draftVersion=useRef(0);
 const peopleByDepartment=new Map<string,Options['people']>();
 const departments=new Map<string,string>();
 const nameQuery=personSearch.trim().toLowerCase();
 for(const person of options.people){
  const department=person.departmentName||'未分配部门';
  const departmentKey=String(person.departmentId??department);
  departments.set(departmentKey,department);
  if(nameQuery&&!person.name.toLowerCase().includes(nameQuery))continue;
  if(!nameQuery&&departmentFilter&&departmentKey!==departmentFilter)continue;
  const people=peopleByDepartment.get(department)??[];
  people.push(person);
  peopleByDepartment.set(department,people);
 }

 useEffect(()=>{
  if(!bridge?.getOriginalVideoStatuses||!list.rows.length)return;
  let active=true;
  const identities=list.rows.map(({afterSaleId,sourceCompany})=>({afterSaleId,sourceCompany}));
  void bridge.getOriginalVideoStatuses(identities).then(statuses=>{
   if(active)setRecordings(Object.fromEntries(statuses.map(status=>[recordingKey(status),status.state])));
  }).catch(()=>{if(active)setRecordings({});});
  return()=>{active=false;};
 },[bridge,list.rows]);

 useEffect(()=>{
  let active=true;
  if(bridge?.getOriginalGoodsImages&&list.rows.length&&login?.state==='authenticated')void bridge.getOriginalGoodsImages(list.rows.map(({afterSaleId,sourceCompany})=>({afterSaleId,sourceCompany})))
   .then(rows=>{if(active)setGoodsImages(Object.fromEntries(rows.map(row=>[recordingKey(row),row.images])));}).catch(()=>{if(active)setGoodsImages({});});
  else setGoodsImages({});
  return()=>{active=false;};
 },[bridge,list.rows,login?.state,login?.sourceCompany]);

 const followPeople=options.people.filter(person=>person.id!==options.currentUserId&&
  ((options.currentDepartmentId!=null&&person.departmentId===options.currentDepartmentId)||String(person.id)===owner));
 const pendingFiles=selected?.files.filter(file=>selected.pendingFileIds?.includes(file.id))??[];

 const loadList=useCallback(async(p=page)=>{
  const seq=++listRequest.current;
  const query={keyword,page:p,sort:sort.key,direction:sort.direction,state:listMode};
  const value=filters.length
   ? await api<List>(BASE+'/search',{body:{...query,filters}})
   : await api<List>(BASE+'?'+new URLSearchParams({...query,page:String(p)}));
  if(seq===listRequest.current)setList(value);
 },[page,keyword,sort,filters,listMode]);
 useEffect(()=>{
  let active=true;
  void loadList().catch(e=>{if(active)setError(errorMessage(e));});
  const refresh=()=>{if(active)void loadList().catch(()=>undefined);};
  const refreshVisible=()=>{if(document.visibilityState==='visible')refresh();};
  const timer=setInterval(refresh,filters.length?30000:5000);
  window.addEventListener('focus',refresh);
  document.addEventListener('visibilitychange',refreshVisible);
  return()=>{
   active=false;
   clearInterval(timer);
   window.removeEventListener('focus',refresh);
   document.removeEventListener('visibilitychange',refreshVisible);
   listRequest.current++;
  };
 },[loadList,filters.length]);
 useEffect(()=>{
  let active=true;
  void api<Options>(BASE+'/options').then(v=>{if(active)setOptions(v);}).catch(e=>{if(active)setError(errorMessage(e));});
  return()=>{active=false;request.current++;};
 },[]);

 const logClick=async(id:number,click:DesktopSaleClick)=>{
  const identity=tokenStore.get();
  try{
   const event=await api<DesktopSaleEvent>(BASE+'/'+id+'/activity',{body:{click}});
   const current=selectedRef.current;
   if(tokenStore.get()!==identity||current?.id!==id||event.kind!=='activity'||current.events.some(item=>item.id===event.id))return;
   const next={...current,events:[event,...current.events]};
   selectedRef.current=next;
   setSelected(next);
  }catch(e){
   if(tokenStore.get()===identity)setError('售后操作日志保存失败 · '+errorMessage(e));
  }
 };
 const withActivity=(archive:DesktopSaleArchive)=>{
  const current=selectedRef.current;
  if(current?.id!==archive.id)return archive;
  const ids=new Set(archive.events.map(event=>event.id));
  const recent=current.events.filter(event=>event.kind==='activity'&&!ids.has(event.id));
  return recent.length?{...archive,events:[...recent,...archive.events]}:archive;
 };
 const accept=(record:DesktopSaleArchive)=>{
  const v=withActivity(record);
  draftVersion.current=v.version;
  selectedRef.current=v;
  setSelected(v);
  setOwner(v.ownerId?String(v.ownerId):'');
  setNextAt(localDate(v.nextAt));
  setNote('');
  dirty.current=false;
 };
 const acceptAttachment=(record:DesktopSaleArchive)=>{
  const v=withActivity(record);
  const current=selectedRef.current;if(!current||current.id!==v.id||v.version<current.version)return;
  if(!dirty.current){accept(v);return;}
  if(v.version===current.version){selectedRef.current=v;setSelected(v);return;}
  const sameFollow=current.progress===v.progress&&current.ownerId===v.ownerId&&current.nextAt===v.nextAt;
  if(draftVersion.current===current.version&&v.version===current.version+1&&sameFollow&&current.priority===v.priority&&current.rowColor===v.rowColor&&current.report===v.report)draftVersion.current=v.version;
  else setError('档案被其他人更新，请点击刷新版本核对处理进度，本次记录会保留。');
  selectedRef.current=v;setSelected(v);
 };
 async function run(action:()=>Promise<void>){setBusy(true);setError('');setVideoFallback(null);try{await action();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}

 const sourceProblem=(record:DesktopSaleArchive)=>login?.state==='login_required'?'请先登录聚水潭':login?.state==='authenticated'&&login.sourceCompany&&login.sourceCompany!==record.snapshot.sourceCompany?'当前登录的聚水潭公司与该售后来源不同':null;
 const querySource=async(record:DesktopSaleArchive)=>{
  if(!lookup?.query)return;
  const {afterSaleId,internalOrderId,sourceCompany}=record.snapshot;
  const query={field:'afterSaleId' as const,value:afterSaleId,sourceCompany,page:1,sourceColumns:true};
  const match=(records:DesktopSaleSnapshot[])=>records.find(s=>s.afterSaleId===afterSaleId&&s.sourceCompany===sourceCompany&&
    (!internalOrderId||!s.internalOrderId||s.internalOrderId===internalOrderId));
  const current=await lookup.query({...query,kind:'current'});
  const result=match(current.records)??match((await lookup.query({...query,kind:'history'})).records);
  if(!result)throw new Error('聚水潭当前和历史列表未找到这笔售后');
  return result;
 };
 const refreshPanel=async(record:DesktopSaleArchive,kind:DesktopSourcePanel,active:()=>boolean,forceLookup=false,pending?:Promise<DesktopSaleSnapshot|null>)=>{
  if(!bridge?.readSourcePanel)return;
  const {afterSaleId,sourceCompany,internalOrderId}=record.snapshot;
  setSourceStatus({text:'正在读取聚水潭明细…'});
  try{
   const snapshot=await (pending??bridge.readSourcePanel({kind,afterSaleId,sourceCompany,...(forceLookup?{forceLookup:true}:{})}));
   if(!active())return;
   if(snapshot&&(snapshot.afterSaleId!==afterSaleId||snapshot.sourceCompany!==sourceCompany||
      (internalOrderId&&snapshot.internalOrderId&&snapshot.internalOrderId!==internalOrderId))){
    throw new Error('聚水潭返回的明细与当前售后单不一致');
   }
   const field=SOURCE_PANELS[kind].field;
   const content=snapshot?.fields[field];
   if(!snapshot||!content?.trim()){
    setSourceStatus({text:record.snapshot.fields[field]?'聚水潭本次没有返回明细，正在显示已归档内容':'聚水潭本次没有返回明细'});
    return;
   }
   const updated=await api<DesktopSaleArchive>(BASE+'/'+record.id+'/source',{body:{...snapshot,fields:{[field]:content}}});
   if(active()){acceptAttachment(updated);setSourceStatus({text:'聚水潭明细已归档'});}
  }catch(e){
   if(active())setSourceStatus({text:'聚水潭明细读取失败 · '+errorMessage(e),error:true});
  }
 };
 const select=async(id:number,target?:DesktopSourcePanel|'sale'|'order',anchor?:HTMLButtonElement,preview?:DesktopSaleSnapshot)=>{
  if(dirty.current&&!confirm('当前有未保存的跟进内容，确定切换售后吗？'))return;
  const sequence=++request.current,identity=tokenStore.get();
  panelReturnTab.current=null;documentReturnTab.current=null;
  const active=()=>sequence===request.current&&tokenStore.get()===identity;
  const panel=target&&target!=='sale'&&target!=='order'?target:null;
  setPanelPreview(panel&&preview?{kind:panel,snapshot:preview,anchor:anchor??null}:null);
  await run(async()=>{
   const archive=api<DesktopSaleArchive>(BASE+'/'+id);
   let pending:Promise<DesktopSaleSnapshot|null>|undefined;
   if(panel&&preview&&!preview.fields[SOURCE_PANELS[panel].field]?.trim()&&login?.state==='authenticated'&&login.sourceCompany===preview.sourceCompany){
    const {afterSaleId,sourceCompany}=preview;
    pending=bridge?.readSourcePanel?.({kind:panel,afterSaleId,sourceCompany});
    // The archive request may finish after the native read rejects.
    void pending?.catch(()=>undefined);
   }
   const record=await archive;if(!active())return;
   if(pending&&(record.snapshot.afterSaleId!==preview?.afterSaleId||record.snapshot.sourceCompany!==preview.sourceCompany))pending=undefined;
   setPanelPreview(null);
   setCloseReason(null);setNotifyOpen(false);setRecipient('');setMessage('');setPersonSearch('');setBrowsePeople(false);setDepartmentFilter('');setActionStatus('');
   setTab(target==='order'?'order':target?'source':'follow');setSourcePanel(panel);setPopupAnchor(anchor??null);accept(record);
   setSourceStatus(null);
   void logClick(id,target==='order'?'view_order':target?'view_source':'open_case');
   void refreshSelected(record,target,panel,active,false,pending);
  });
  if(active())setPanelPreview(null);
 };
 const refreshSelected=async(record:DesktopSaleArchive,target:DesktopSourcePanel|'sale'|'order'|undefined,panel:DesktopSourcePanel|null,active:()=>boolean,forceLookup=false,pending?:Promise<DesktopSaleSnapshot|null>)=>{
  setSourceLoading(true);
  try{
   const problem=sourceProblem(record);
   if(problem){setSourceStatus({text:'正在显示 OA 已归档数据 · '+problem,error:true});return;}
   if(target==='order'){await readOrder(record,active);return;}
   if(target==='sale'&&bridge?.readSaleDetail){
    setSourceStatus({text:'正在读取聚水潭售后单详情…'});
    const {afterSaleId,internalOrderId,sourceCompany}=record.snapshot;
    try{
     const details=await bridge.readSaleDetail({afterSaleId,internalOrderId,sourceCompany});
     if(!active())return;
     if(!details)throw new Error('聚水潭未返回这笔售后的详情');
     if(details.afterSaleId!==afterSaleId||details.sourceCompany!==sourceCompany||
        (internalOrderId&&details.internalOrderId!==internalOrderId))throw new Error('聚水潭返回的详情与当前售后单不一致');
     const {productImages,...snapshot}=details;
     const updated=await api<DesktopSaleArchive>(BASE+'/'+record.id+'/source',{body:snapshot});
     if(active()){
      const table=snapshot.fields['售后详情商品明细'];
      if(table&&table===updated.snapshot.fields['售后详情商品明细'])setDocumentImages({key:recordingKey(snapshot),kind:'sale',table,images:productImages??[]});
      acceptAttachment(updated);setSourceStatus(null);
     }
    }catch(e){
     if(active())setSourceStatus({text:'正在显示 OA 已归档数据 · '+errorMessage(e),error:true});
    }
    return;
   }
   if(panel){await refreshPanel(record,panel,active,forceLookup,pending);return;}
   if(!lookup?.query)return;
   setSourceStatus({text:'正在查询聚水潭最新状态…'});
   try{
    const snapshot=await querySource(record);if(!active()||!snapshot)return;
    const updated=await api<DesktopSaleArchive>(BASE+'/'+record.id+'/source',{body:snapshot});
   if(active()){acceptAttachment(updated);setSourceStatus(null);void loadList().catch(()=>undefined);}
   }catch(e){
    if(active())setSourceStatus({text:'正在显示 OA 已归档数据 · '+errorMessage(e),error:true});
   }
  }finally{if(active())setSourceLoading(false);}
 };

 useEffect(()=>{
  if(!bridge||!portal||!viewport.current)return;
  const el=viewport.current;
  let active=true;
  const mount=()=>{const r=el.getBoundingClientRect();return bridge.mount({x:r.x,y:r.y,width:r.width,height:r.height});};
  const showError=(e:unknown)=>{if(active){if(portal!=='source')setPortal(null);setError(errorMessage(e));}};
  const sync=()=>{void mount().catch(showError);};
  const observer=new ResizeObserver(sync);observer.observe(el);window.addEventListener('resize',sync);
  void mount().then(()=>active&&portal==='source'?bridge.openSourceAfterSales?.():undefined).catch(showError);
  return()=>{active=false;observer.disconnect();window.removeEventListener('resize',sync);void bridge.hide().catch(()=>undefined);};
 },[bridge,portal]);
 useEffect(()=>()=>{void bridge?.context(null).catch(()=>undefined);},[bridge]);
 useEffect(()=>{void bridge?.context(selected?{id:selected.id,afterSaleId:selected.snapshot.afterSaleId}:null).catch(()=>undefined);},[bridge,selected?.id]);
 useEffect(()=>{if(!bridge)return;return bridge.onScreenshot(shot=>{
  const current=selectedRef.current;
  const identity=tokenStore.get();
  const requested=captureRequest.current;
  if(shot.autoAttach){
   if(!requested||requested.id!==shot.id||requested.afterSaleId!==shot.afterSaleId||requested.identity!==identity)return;
   captureRequest.current=null;
  }else if(current?.id!==shot.id||current.snapshot.afterSaleId!==shot.afterSaleId){
   setError('截图对应的售后已切换，未上传。截图已复制，可在对应档案手动粘贴。');
   return;
  }
  setCaptureStatus({id:shot.id,text:'正在保存截图…',pending:true});
  void (async()=>{
   try{
    const blob=await(await fetch(shot.image)).blob();
    if(tokenStore.get()!==identity)return;
    const form=new FormData();
    form.append('file',blob,'售后-'+shot.afterSaleId+'-'+Date.now()+'.png');
    const archive=await api<DesktopSaleArchive>(BASE+'/'+shot.id+'/files',{method:'POST',form});
    if(tokenStore.get()!==identity)return;
    acceptAttachment(archive);
    setCaptureStatus({id:shot.id,text:'已保存 '+(archive.pendingFileIds?.length??1)+' 张待归档截图',pending:false});
   }catch(e){
    if(tokenStore.get()!==identity)return;
    setCaptureStatus(null);
    setError('售后 '+shot.afterSaleId+' 截图保存失败 · '+errorMessage(e));
   }
  })();
 });},[bridge]);
 const takeScreenshot=(record:DesktopSaleArchive)=>run(async()=>{
  if(!bridge)return;
  void logClick(record.id,'start_screenshot');
  const target={id:record.id,afterSaleId:record.snapshot.afterSaleId};
  const intent={...target,identity:tokenStore.get()};
  captureRequest.current=intent;
  setCaptureStatus(null);
  try{
   if(!await bridge.screenshot({...target,autoAttach:true}))throw new Error('未能打开截图工具');
  }catch(error){
   if(captureRequest.current===intent)captureRequest.current=null;
   throw error;
  }
 });
 const save=(reason?:string)=>run(async()=>{
  if(!selected)return;
  await logClick(selected.id,reason?'confirm_close':'click_save_follow');
  const body={version:draftVersion.current,progress:note.trim().slice(0,300)||selected.progress,ownerId:owner?Number(owner):null,
   nextAt:nextAt?new Date(nextAt).toISOString():null,note};
  const archive=await api<DesktopSaleArchive>(BASE+'/'+selected.id+(reason?'/close':'/follow'),{
   method:'POST',body:reason?{...body,reason}:body,
  });
  accept(archive);
  setCaptureStatus(status=>status?.id===archive.id?null:status);
  setCloseReason(null);
  await loadList();
 });
 const confirmClose=()=>{
  const reason=closeReason?.trim();
  if(!reason||!selected)return;
  if(confirm('确定完结这笔 OA 售后？填写的处理记录和完结理由将一并保存。'))void save(reason);
  else void logClick(selected.id,'cancel_close');
 };
 const loadEarlier=(record:DesktopSaleArchive)=>run(async()=>{
  const before=record.nextEventsBefore;
  if(!before)return;
  void logClick(record.id,'load_history');
  const value=await api<DesktopSaleArchive>(BASE+'/'+record.id+'/events?before='+before);
  const current=selectedRef.current;
  if(current?.id!==record.id||current.nextEventsBefore!==before)return;
  const events=new Map(current.events.map(event=>[event.id,event]));
  for(const event of value.events)events.set(event.id,event);
  const next={...current,events:[...events.values()],nextEventsBefore:value.nextEventsBefore};
  selectedRef.current=next;
  setSelected(next);
 });
 const sendNotice=(record:DesktopSaleArchive)=>run(async()=>{
  await logClick(record.id,'click_send_notice');
  const result=await api<{assistantQueued:number}>('/desktop-after-sales-shared/'+record.id+'/share',{
   body:{recipients:[Number(recipient)],message:message.trim(),canWrite:true},
  });
  setNotifyOpen(false);setRecipient('');setMessage('');setPersonSearch('');setBrowsePeople(false);setDepartmentFilter('');
  setActionStatus(result.assistantQueued?'已发站内通知，助手消息已排队':'已发站内通知，助手消息未排队');
  acceptAttachment(await api<DesktopSaleArchive>(BASE+'/'+record.id));
 });
 const sendTear=(record:DesktopSaleArchive)=>run(async()=>{
  await logClick(record.id,'click_tear');
  const result=await api<{archive:DesktopSaleArchive;recipients:number;assistantQueued:number}>(BASE+'/'+record.id+'/tear',{
   body:{version:draftVersion.current},
  });
  if(selectedRef.current?.id===record.id){
   draftVersion.current=result.archive.version;
   const latest=withActivity(result.archive);
   selectedRef.current=latest;
   setSelected(latest);
   setNextAt('');
   setActionStatus(result.recipients
    ?'已通知仓储部 '+result.recipients+' 人，'+result.assistantQueued+' 条助手消息已排队'
    :'这笔售后已在撕单列表');
  }
  await loadList();
 });
 const openEvidence=(record:DesktopSaleArchive,file:DesktopSaleArchive['files'][number])=>run(async()=>{
  void logClick(record.id,'view_file');
  const result=await api<{url:string}>(BASE+'/'+record.id+'/files/'+file.id+'/url');
  if(file.mime.startsWith('image/'))setEvidencePreview({url:result.url,name:file.name});
  else window.open(result.url,'_blank','noopener');
 });
 const reloadVersion=(record:DesktopSaleArchive)=>run(async()=>{
  void logClick(record.id,'refresh_archive');
  const latest=await api<DesktopSaleArchive>(BASE+'/'+record.id);
  if(selectedRef.current?.id!==record.id)return;
  accept(latest);
  if(!latest.closed){setNote(note);setOwner(owner);setNextAt(nextAt);dirty.current=true;}
 });
 const readOrder=async(record:DesktopSaleArchive,active:()=>boolean)=>{
  const {afterSaleId,internalOrderId,sourceCompany}=record.snapshot;
  if(!bridge?.readOrderDetail||!internalOrderId)return;
  const identity={afterSaleId,internalOrderId,sourceCompany};
  setSourceStatus({text:'正在读取聚水潭内部订单…'});
  try{
   const matches=(s:DesktopSaleSnapshot)=>s.afterSaleId===afterSaleId&&s.internalOrderId===internalOrderId&&s.sourceCompany===sourceCompany;
   const found=await bridge.readOrderDetail(identity);
   if(!active())return;
   if(!found)throw new Error('聚水潭订单详情尚未读完，请重试');
   if(!matches(found))throw new Error('聚水潭返回的详情与当前内部订单不一致');
   const fields=Object.fromEntries(INTERNAL_ORDER_FIELDS.flatMap(field=>
    found.fields[field]===undefined?[]:[[field,found.fields[field]]]));
   if(!Object.keys(fields).length)throw new Error('未读取到内部订单明细');
   const {productImages,...snapshot}=found;
   const updated=await api<DesktopSaleArchive>(`${BASE}/${record.id}/source`,{body:{...snapshot,fields}});
   if(active()){
    const table=snapshot.fields['商品明细'];
    if(table&&table===updated.snapshot.fields['商品明细'])setDocumentImages({key:recordingKey(snapshot),kind:'order',table,images:productImages??[]});
    acceptAttachment(updated);setSourceStatus({text:'聚水潭内部订单详情已归档'});
   }
  }catch(e){
   if(active())setSourceStatus({text:'聚水潭内部订单读取失败 · '+errorMessage(e),error:true});
  }
 };
 const readDiscount=async(record:DesktopSaleArchive)=>{
  void logClick(record.id,'view_discount');
  const problem=sourceProblem(record);
  if(problem)throw new Error(problem);
  if(!bridge?.readOrderDiscount)return;
  const {afterSaleId,internalOrderId,sourceCompany}=record.snapshot;
  const sequence=request.current,token=tokenStore.get();
  const active=()=>sequence===request.current&&token===tokenStore.get()&&selectedRef.current?.id===record.id;
  const snapshot=await bridge.readOrderDiscount({afterSaleId,internalOrderId,sourceCompany});
  if(!active())return;
  if(!snapshot)throw new Error('聚水潭没有返回这笔订单的优惠明细');
  if(snapshot.afterSaleId!==afterSaleId||snapshot.internalOrderId!==internalOrderId||snapshot.sourceCompany!==sourceCompany){
   throw new Error('聚水潭返回的优惠明细与当前订单不一致');
  }
  const updated=await api<DesktopSaleArchive>(BASE+'/'+record.id+'/source',{body:snapshot});
  if(active())acceptAttachment(updated);
 };
 const showOrder=(record:DesktopSaleArchive,track=true)=>{
  if(track)void logClick(record.id,'view_order');
  if(tab==='follow'||tab==='changes')documentReturnTab.current=tab;
  const sequence=++request.current,identity=tokenStore.get();
  setTab('order');setSourceStatus(null);
  void refreshSelected(record,'order',null,()=>sequence===request.current&&selectedRef.current?.id===record.id&&tokenStore.get()===identity);
 };
 const showSale=(record:DesktopSaleArchive)=>{
  void logClick(record.id,'view_source');
  const sequence=++request.current,identity=tokenStore.get();
  setTab('source');setSourceStatus(null);
  void refreshSelected(record,'sale',null,()=>sequence===request.current&&selectedRef.current?.id===record.id&&tokenStore.get()===identity);
 };
 const changeFilters=(values:AfterSalesColumnFilter[])=>{setFilters(values);setPage(1);};
 const openFilter=(column:AfterSalesColumn)=>{setFilterColumn(column);setFilterText(filters.find(f=>f.column===column)?.value??'');};
 const applyFilter=(value:string)=>{
  if(!filterColumn)return;
  const next=filters.filter(f=>f.column!==filterColumn);
  if(value&&next.length>=AFTER_SALES_MAX_FILTERS){setError(`最多同时筛选 ${AFTER_SALES_MAX_FILTERS} 列`);return;}
  changeFilters(value?[...next,{column:filterColumn,value}]:next);setFilterColumn(null);
 };
 const openSource=desktop?.openSourceWindow?()=>void desktop.openSourceWindow!().then(opened=>{if(!opened)setError('聚水潭窗口未打开，请重试。');}).catch(e=>setError(errorMessage(e))):bridge?()=>setPortal('source'):undefined;
 const sourceButton=<><ExternalLink size={15}/> 打开聚水潭售后页面</>;
 const copySourceNumber=async(column:AfterSalesColumn,value:string,id:number)=>{
  void logClick(id,'copy_number');
  try{await navigator.clipboard.writeText(value);setCopyStatus(`已复制${column}`);}
  catch{setCopyStatus(`复制${column}失败，请手动复制`);}
 };
 const openOriginalField=(snapshot:DesktopSaleSnapshot,column:JstAfterSalesOriginalColumn,id=selectedRef.current?.id,action?:'attachment')=>run(async()=>{
  if(id)void logClick(id,'view_source');
  if(!bridge?.openOriginalField)throw new Error('请在新版 OA 桌面客户端打开聚水潭字段');
  if(login?.state==='login_required'){
   openSource?.();
   throw new Error('请先登录聚水潭，再打开对应字段');
  }
  const {afterSaleId,sourceCompany}=snapshot;
  if(login?.state==='authenticated'&&login.sourceCompany!==sourceCompany){
   throw new Error('当前登录的聚水潭公司与该售后来源不同');
  }
  if(!await bridge.openOriginalField({afterSaleId,sourceCompany,column,...(action?{action}:{})})){
   throw new Error(`聚水潭原列表没有显示「${column}」，可在原页面检查显示列和权限`);
  }
 });
 const openOriginalPanel=(snapshot:DesktopSaleSnapshot,kind:DesktopSourcePanel)=>run(async()=>{
  if(selectedRef.current)void logClick(selectedRef.current.id,'view_source');
  if(!bridge?.openOriginalSourcePanel)throw new Error('请使用最新的本地客户端打开原明细');
  const {afterSaleId,sourceCompany}=snapshot;
  if(!await bridge.openOriginalSourcePanel({afterSaleId,sourceCompany,kind}))throw new Error('聚水潭原明细窗口未打开');
 });
 const openVideo=(snapshot:DesktopSaleSnapshot,id:number)=>run(async()=>{
  void logClick(id,'view_video');
  if(!bridge?.prepareRecording&&!bridge?.openOriginalVideo)return;
  if(login?.state==='login_required'){
   throw new Error('请先登录聚水潭，再打开视频监控');
  }
  const {afterSaleId,sourceCompany}=snapshot;
  if(login?.state==='authenticated'&&login.sourceCompany!==sourceCompany){
   throw new Error('当前登录的聚水潭公司与该售后来源不同');
  }
  const identity={afterSaleId,sourceCompany};
  if(bridge.prepareRecording){
   const result=await bridge.prepareRecording(identity);
   if(result.state==='ready'){
    setRecordings(current=>({...current,[recordingKey(identity)]:'available'}));
    setPortal(result.player==='assistant'?'assistant-video':'video');
    return;
   }
   if(result.state==='unavailable'){
    setRecordings(current=>({...current,[recordingKey(identity)]:'unavailable'}));
    throw new Error('聚水潭显示这笔售后无录像');
   }
   if(result.state==='helper-required'||result.state==='denied'){
    setRecordings(current=>({...current,[recordingKey(identity)]:'available'}));
    throw new Error(result.state==='helper-required'
     ?'请启动聚水潭 ERP 助手后再播放录像'
     :'当前聚水潭账号没有录像回放权限');
   }
   if(result.state==='external'&&bridge.openOriginalVideo){
    setVideoFallback({identity,id});
    throw new Error('OA 未能加载这笔售后的播放器');
   }
   if(result.state==='missing'&&result.hasRecording){
    setRecordings(current=>({...current,[recordingKey(identity)]:'available'}));
    throw new Error('聚水潭确认有录像，当前页面未显示播放入口');
   }
   throw new Error('聚水潭未显示这笔售后的可用视频监控入口');
  }
  if(!await bridge.openOriginalVideo?.(identity))throw new Error('未能打开这笔售后的聚水潭视频监控');
 });
 const closeDetails=()=>{
  if(panelReturnTab.current&&sourcePanel){
   request.current++;
   setTab(panelReturnTab.current);panelReturnTab.current=null;
   setSourceLoading(false);setSourceStatus(null);setSourcePanel(null);setPopupAnchor(null);setPanelPreview(null);
   return;
  }
  if(documentReturnTab.current&&(tab==='order'||tab==='source')){
   request.current++;
   setTab(documentReturnTab.current);documentReturnTab.current=null;
   setSourceLoading(false);setSourceStatus(null);
   return;
  }
  if(dirty.current&&!confirm('放弃未保存的跟进内容？'))return;
  if(selectedRef.current)void logClick(selectedRef.current.id,'leave_case');
  request.current++;
  setSourceLoading(false);setPopupAnchor(null);setSourcePanel(null);setPanelPreview(null);setCloseReason(null);setSelected(null);selectedRef.current=null;
 };
 const showPanel=(panel:DesktopSourcePanel,forceLookup=false)=>{
  const record=selectedRef.current;
  if(!record)return;
  if(!forceLookup){
   void logClick(record.id,'view_source');
   if(tab==='source'||tab==='changes')panelReturnTab.current=tab;
  }
  const identity=tokenStore.get();
  setTab('source');
  setSourcePanel(panel);
  setPopupAnchor(null);
  setSourceStatus(null);
  const sequence=++request.current;
  void refreshSelected(record,panel,panel,()=>sequence===request.current&&selectedRef.current?.id===record.id&&tokenStore.get()===identity,forceLookup);
 };
 const retrySelected=()=>{
  const record=selectedRef.current;
  if(!record)return;
  void logClick(record.id,'retry_source');
  if(tab==='order'){showOrder(record,false);return;}
  if(tab==='source'&&sourcePanel){showPanel(sourcePanel,true);return;}
  const sequence=request.current,identity=tokenStore.get();
  void refreshSelected(record,tab==='source'?'sale':undefined,null,()=>sequence===request.current&&selectedRef.current?.id===record.id&&tokenStore.get()===identity);
 };
 const caseWorkspace=tab==='follow'||tab==='changes';
 const currentDocumentImages=selected&&documentImages?.kind=== (tab==='source'?'sale':tab)&&documentImages.key===recordingKey(selected.snapshot)&&
  documentImages.table===selected.snapshot.fields[tab==='source'?'售后详情商品明细':'商品明细']?documentImages.images:undefined;
 const popup=panelPreview??(selected&&tab==='source'&&sourcePanel?{kind:sourcePanel,snapshot:selected.snapshot,anchor:popupAnchor}:null);
 return <div className="desktop-sales">
  <header className="ds-heading"><h2>实时售后处理</h2><DesktopJushuitanStatus status={login} onOpen={openSource}/></header>
  <section className="ds-list-tools" aria-label="售后功能区">
   <form className="ds-search" onSubmit={e=>{e.preventDefault();const value=search.trim();if(value===keyword&&page===1)void loadList(1).catch(e=>setError(errorMessage(e)));else{setKeyword(value);setPage(1);}}}>
    <input aria-label="搜索售后单号或内部订单号" placeholder="售后单号 / 内部订单号" value={search} maxLength={80} onChange={e=>setSearch(e.target.value)}/>
    <button type="submit"><Search size={14}/> 搜索</button>
   </form>

   {columnsFailed&&<button type="button" onClick={retry}>列设置未同步 · 重试</button>}
   {openSource?<button type="button" className="ds-source-link" onClick={openSource}>{sourceButton}</button>:<a className="ds-source-link" href={DESKTOP_AFTER_SALES_SOURCE_LINK}>{sourceButton}</a>}
   <div className="ds-actions ds-workspace-modes" aria-label="售后分类">
    {([['open','待处理'],['tear','撕单售后'],['closed','已完结售后']] as const).map(([mode,label])=>
     <button type="button" key={mode} className={listMode===mode?'chosen':''} aria-pressed={listMode===mode}
      onClick={()=>{setListMode(mode);setPage(1);}}>{label}</button>,
    )}
    <button type="button" aria-expanded={showColumns} onClick={()=>setShowColumns(value=>!value)}>显示列</button>
   </div>
  </section>
  <DesktopCollectionStatus/>
  {import.meta.env.DEV&&bridge?.localAcceptancePage&&<DesktopAfterSalesAcceptance bridge={bridge}/>}
  {error&&!selected&&!popup&&<div role="alert" className="ds-error">{error}
   {videoFallback&&<button type="button" onClick={()=>void run(async()=>{
    const {id,identity}=videoFallback;
    setVideoFallback(null);
    void logClick(id,'view_video');
    if(!await bridge?.openOriginalVideo?.(identity))throw new Error('未能打开聚水潭原播放器');
   })}>在聚水潭打开录像</button>}
   <button onClick={()=>{setError('');setVideoFallback(null);}}>关闭</button></div>}
  {showColumns&&<ColumnPicker columns={columns} onChange={changeColumns} onResetWidths={resetWidths}/>}
  {filterColumn&&<form className="ds-filter-form ds-actions" onSubmit={e=>{e.preventDefault();applyFilter(filterText.trim());}} onKeyDown={e=>{if(e.key==='Escape')setFilterColumn(null);}}>
   <label>{filterColumn}<input autoFocus aria-label={`${filterColumn}包含`} placeholder="包含的文字" maxLength={120} value={filterText} onChange={e=>setFilterText(e.target.value)}/></label>
   <button type="submit">筛选</button><button type="button" onClick={()=>applyFilter('')}>清除此列</button><button type="button" onClick={()=>setFilterColumn(null)}>取消</button>
  </form>}
  {filters.length>0&&<div className="ds-actions ds-filter-tags" aria-label="生效中的筛选">
   {filters.map(f=><button type="button" key={f.column} aria-label={`移除${f.column}筛选`} onClick={()=>changeFilters(filters.filter(v=>v!==f))}>{f.column} · {f.value}<X size={13}/></button>)}
   <button type="button" onClick={()=>changeFilters([])}>清空筛选</button>
  </div>}
  <div className="ds-table-wrap">
   <table className="ds-table ds-jst-list" style={{width:`calc(${tableWidth}px + var(--ds-resize-delta, 0px))`}}>
    <colgroup>{tableColumns.map(column=><col key={column} style={{width:`var(--ds-preview-width, ${columnWidth(column)}px)`}}/>)}</colgroup>
    <AfterSalesTableHead columns={columns} filters={filters} sort={sort} columnWidth={columnWidth} onResize={changeWidth} onSort={value=>{setSort(value);setPage(1);}}
      onFilter={openFilter} onMove={(from,to)=>changeColumns(moveColumn(columns,from,to))}/>
    <tbody>{list.rows.map((r,i)=>{
     const recording=recordings[recordingKey(r)];
     return <tr key={r.id} style={{backgroundColor:r.rowColor||undefined}}>
     <td>{(page-1)*AFTER_SALES_PAGE_SIZE+i+1}</td>
     {columns.map(k=>{
      const panel=SOURCE_CELL_PANELS[k],raw=afterSalesCell(r,k);
      const value=panel==='refund'?raw.split('\n').filter(line=>line.trim()!=='查看明细').join('\n').trim():raw;
      const goodsTotal=panel==='goods'?value.match(/合计\s*[:：]\s*(\d+)/)?.[1]:undefined;
      const logistics=k==='退货快递单号'||k==='发货快递单号';
      const waybill=logistics?value.split('\n').find(line=>/^(?=[A-Z0-9-]{6,40}$)[A-Z-]*\d[A-Z0-9-]*$/i.test(line.trim()))?.trim():undefined;
      const canCopy=SOURCE_COPY_FIELDS.has(k)||!!waybill;
      const copyButton=canCopy&&value&&<button type="button" className="ds-copy-number"
       aria-label={`复制${k}`} title={`复制${k}`} onClick={()=>void copySourceNumber(k,waybill??value,r.id)}><Copy size={13}/></button>;
      const flagColor=safeColor(r.snapshot.fields['原订单旗帜']);
      const attachmentLabel=k==='售后问题登记'?r.snapshot.fields['售后问题附件']:k==='供分销备注'?r.snapshot.fields['供分销备注附件']:undefined;
      const attachment=attachmentLabel&&/下载/.test(attachmentLabel)&&!/上传/.test(attachmentLabel)?attachmentLabel:undefined;
      const sourceEditable=r.snapshot.fields['原列表可编辑字段'];
      const hasSourceEditor=sourceEditable===undefined||sourceEditable.split('\n').includes(k);
      const editButton=hasOriginalField(k)&&hasSourceEditor&&SOURCE_EDIT_FIELDS.has(k)&&<button type="button" className="ds-link ds-order-remark-edit"
       disabled={busy} aria-label={`在聚水潭打开${k}`} title={`在聚水潭打开${k}`}
       onClick={()=>void openOriginalField(r.snapshot,k,r.id)}><Pencil size={13} aria-hidden="true"/></button>;
      const originalButton=(column:JstAfterSalesOriginalColumn,label:string)=><button type="button" className="ds-link ds-original-field"
       disabled={busy} aria-label={`在聚水潭打开${column}`} title={`在聚水潭打开${column}`}
       onClick={()=>void openOriginalField(r.snapshot,column,r.id)}>{label}</button>;
      return <td key={k} data-column={k}>{k==='售后单号'
       ? <><span className="ds-sale-number-label">售后单号：</span><button className="ds-link" title={r.afterSaleId} disabled={busy} onClick={()=>void select(r.id,'sale')}>{r.afterSaleId}</button>{copyButton}</>
       : k==='内部订单号'&&value
        ? <><button className="ds-link" title={value} disabled={busy} onClick={()=>void select(r.id,'order')}>{value}</button>{copyButton}</>
        : k==='紧急度'
        ? <span className={`ds-urgency ds-urgency-${r.priority??0}`}>{value}</span>
        : k==='平台售后详情'
        ? (value ? <button type="button" className="ds-link" disabled={busy}
           onClick={()=>void select(r.id,'platform',undefined,r.snapshot)}>{SOURCE_PANELS.platform.label}</button> : <span>—</span>)
        : logistics&&waybill
        ? <div className="ds-waybill">{value.split('\n').map((line,index)=>line.trim()===waybill
           ? <div key={index}><button type="button" className="ds-link" title={waybill} disabled={busy} aria-label={k==='退货快递单号'?'查看退货物流':'查看发货物流'}
              onClick={()=>void select(r.id,k==='退货快递单号'?'tracking':'shipping',undefined,r.snapshot)}>{waybill}</button>{copyButton}</div>
           : <span key={index} title={line}>{line}</span>)}{editButton}</div>
        : k==='原订单下单金额'&&value
        ? <><span>{value}</span><button type="button" className="ds-link" aria-haspopup="dialog" aria-label="查看原订单下单金额明细"
           disabled={busy} onClick={event=>{
            if(popupAnchor===event.currentTarget){closeDetails();return;}
            void select(r.id,'orderAmount',event.currentTarget,r.snapshot);
           }}>…</button></>
        : k==='拒绝原因'&&(value==='查看'||r.snapshot.fields['拒绝原因明细'])
        ? <button type="button" className="ds-link" aria-haspopup="dialog" aria-label="查看拒绝原因" disabled={busy}
           onClick={()=>void select(r.id,'refusal',undefined,r.snapshot)}>查看</button>
        : k==='原订单备注/旗帜'
        ? <div className="ds-order-remark">
           {flagColor&&<Flag className="ds-order-flag" size={14} color={flagColor} fill={flagColor} role="img" aria-label="原订单旗帜"/>}
           {value&&<span className="ds-order-remark-text" title={value}>{value}</span>}
           {editButton}
          </div>
        : k==='售后标签'||k==='原订单标签'
        ? <div className="ds-source-tags">{value.split('\n').filter(Boolean).map((tag,index)=>{
           const [color,background]=(r.snapshot.fields[k==='售后标签'?'售后标签样式':'原订单标签样式']??'').split('\n')[index]?.split('/')??[];
           return <span className="ds-source-tag" title={tag} key={index} style={{color:safeColor(color),backgroundColor:safeColor(background)}}>{tag}</span>;
          })}{editButton}</div>
        : k==='原订单线下备注'||k==='售后问题登记'||k==='供分销备注'
        ? <div className="ds-order-remark ds-source-remark-details">
           {value&&<span className="ds-order-remark-text" title={value}>{value}</span>}
           {attachment&&<button type="button" className="ds-link" title={attachment} aria-label={`下载${k}附件`} disabled={busy}
             onClick={()=>void openOriginalField(r.snapshot,k,r.id,'attachment')}><Download size={13}/>{attachment}</button>}
           {editButton}
          </div>
        : k==='退货快递单号'&&editButton
        ? <div className="ds-order-remark ds-source-remark-details">{value&&<span className="ds-order-remark-text">{value}</span>}{editButton}</div>
        : !panel&&hasOriginalField(k)&&hasSourceEditor&&k!=='发货快递单号'&&k!=='原订单下单金额'&&(k!=='聚工单'||value)
        ? <>{originalButton(k,value||'查看原字段')}{copyButton}</>
        : <>{k==='商品信息'?<GoodsPreview value={value} images={goodsImages[recordingKey(r)]}/>:<span className={'ds-cell-value'+(k==='售后单状态'&&value?' ds-sale-state':'')}
          data-state={k==='售后单状态'?value:undefined} title={value||undefined}>{k==='售后单状态'&&value==='已确认'&&<CircleCheck size={11} aria-hidden="true"/>}{value||'—'}</span>}{copyButton}
          {panel&&(value||r.snapshot.fields[SOURCE_PANELS[panel].field])&&<div className={panel==='goods'?'ds-goods-footer':undefined}>
           <button type="button" className="ds-link" disabled={busy} aria-haspopup={panel==='refund'?'dialog':undefined}
             onClick={event=>{
               const anchor=panel==='refund'?event.currentTarget:undefined;
               if(anchor&&popupAnchor===anchor){closeDetails();return;}
               void select(r.id,panel,anchor,r.snapshot);
             }}>{SOURCE_PANELS[panel].label}</button>{goodsTotal&&<span>合计：<strong>{goodsTotal}</strong></span>}</div>}</>}</td>;
     })}
     <td><div className="ds-row-actions">
      <button disabled={busy} onClick={()=>void select(r.id)}>处理</button>
      <button className="ds-link" disabled={busy} onClick={()=>void select(r.id,'logs',undefined,r.snapshot)}>查看日志</button>
      <button className="ds-link" disabled={busy} type="button" onClick={()=>void openOriginalField(r.snapshot,'操作',r.id)}>聚水潭编辑</button>
      {(bridge?.prepareRecording||bridge?.openOriginalVideo)&&<>
       {recording!=='unavailable'&&<button className="ds-link" disabled={busy} type="button" onClick={()=>void openVideo(r.snapshot,r.id)}><Video size={14} aria-hidden="true"/>视频监控</button>}
       <span className={recording==='available'?'ds-recording-available':'ds-recording-muted'}>
        {recording==='available'?'有视频':recording==='unavailable'?'没视频':'未核实'}
       </span>
      </>}
     </div></td>
    </tr>;})}</tbody>
   </table>
   {!list.rows.length&&<div className="ds-empty">暂无匹配的售后记录</div>}
  </div>
  <footer className="ds-pagination"><span>共 {list.total} 条</span>
   <button disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button><span>{page} / {Math.max(1,Math.ceil(list.total/AFTER_SALES_PAGE_SIZE))}</span>
   <button disabled={page*AFTER_SALES_PAGE_SIZE>=list.total} onClick={()=>setPage(page+1)}>下一页</button>
  </footer>
  {copyStatus&&<p className="ds-copy-status" role="status">{copyStatus}</p>}
  {popup&&<DesktopAfterSalesPopup
   title={popup.kind==='platform'&&/^店铺：[^\n]+$/.test(popup.snapshot.fields['平台售后记录']??'')?'提示':SOURCE_PANELS[popup.kind].title} anchor={popup.anchor} panelKind={popup.kind} onClose={closeDetails}
   hideFooter={(popup.kind==='tracking'||popup.kind==='shipping')&&!!popup.snapshot.fields[SOURCE_PANELS[popup.kind].field]&&(!!panelPreview||!sourceStatus?.error)}
   footer={<>
    {!panelPreview&&!popup.anchor&&!sourceLoading&&<button type="button" className="ds-link" onClick={retrySelected}>重查聚水潭</button>}
    {!panelPreview&&(bridge?.openOriginalSourcePanel||bridge?.openOriginalField)&&<button type="button" className="ds-link" disabled={busy} onClick={()=>void (bridge.openOriginalSourcePanel?openOriginalPanel(popup.snapshot,popup.kind):openOriginalField(popup.snapshot,SOURCE_PANEL_COLUMNS[popup.kind]))}>在聚水潭查看</button>}
   </>}>
   {(popup.snapshot.fields[SOURCE_PANELS[popup.kind].field]||!panelPreview)&&(
    popup.kind==='tracking'||popup.kind==='shipping'
     ? <DesktopAfterSalesLogistics key={popup.kind+recordingKey(popup.snapshot)} kind={popup.kind} snapshot={popup.snapshot}
        queryProvider={!panelPreview&&bridge?.readSourcePanel&&selected?()=>{
         void logClick(selected.id,'view_source');
         const problem=sourceProblem(selected);
         if(problem)return Promise.reject(new Error(problem));
         const {afterSaleId,sourceCompany}=popup.snapshot;
         return bridge.readSourcePanel!({afterSaleId,sourceCompany,kind:popup.kind,queryProvider:true});
        }:undefined}/>
     : <DesktopAfterSalesSourcePanel kind={popup.kind} snapshot={popup.snapshot} showHeading={false}
        images={goodsImages[recordingKey(popup.snapshot)]}/>) }
   {panelPreview?<p role="status" className="ds-source-popup-status">正在读取售后档案…</p>
    :sourceStatus&&sourceStatus.text!=='聚水潭明细已归档'&&<p role={sourceStatus.error?'alert':'status'} className="ds-source-popup-status">{sourceStatus.text}</p>}
  </DesktopAfterSalesPopup>}
    {selected&&!popup&&<div className={caseWorkspace?"ds-drawer-backdrop":"ds-drawer-backdrop ds-source-archive-backdrop"}><section className={"ds-detail ds-drawer"+(caseWorkspace?'':' ds-drawer-source')} role="dialog" aria-modal="true" data-document={caseWorkspace?undefined:tab} aria-label={`售后 ${selected.snapshot.afterSaleId}`}><button disabled={busy} className="ds-close" aria-label="关闭售后详情" onClick={closeDetails}><X size={18}/></button><div className="ds-case-header">
     <h3>{tab==='order'?'订单详情':tab==='source'?'售后详情':'售后 '+selected.snapshot.afterSaleId}</h3>
     {caseWorkspace&&<><span>{selected.storeName || selected.snapshot.fields['店铺']}</span>
     <span>内部订单 <button className="ds-link" disabled={busy||!selected.snapshot.internalOrderId} onClick={()=>showOrder(selected)}>{selected.snapshot.internalOrderId||'待聚水潭补齐'}</button></span></>}
     {tab==='source'&&<span>{selected.snapshot.afterSaleId}</span>}
     {tab==='order'&&<span>{selected.snapshot.internalOrderId}</span>}
     </div>
     {error&&<div role="alert" className="ds-error">{error}
      {/(档案被其他人更新|档案已被更新)/.test(error)&&<button type="button" onClick={()=>void reloadVersion(selected)}>刷新版本</button>}
      <button type="button" onClick={()=>setError('')}>关闭提示</button>
     </div>}
     {sourceStatus?.error&&<p role="alert">{sourceStatus.text} {' '}
      {!sourceLoading&&login?.state!=='login_required'&&<button className="ds-link" disabled={busy} type="button" onClick={retrySelected}>重查聚水潭</button>}
      {openSource&&login?.state==='login_required'&&<button type="button" className="ds-link" onClick={openSource}>登录聚水潭</button>}
     </p>}
     {caseWorkspace&&<div className="ds-tabs"><button className={tab==='follow'?'chosen':''} onClick={()=>{void logClick(selected.id,'view_oa_history');setTab('follow');}}>OA 处理记录</button><button className={tab==='changes'?'chosen':''} onClick={()=>{void logClick(selected.id,'view_source_history');setTab('changes');}}>聚水潭字段变更</button></div>}
     {!caseWorkspace&&sourceLoading&&!sourceStatus?.error&&<p className="ds-document-status" role="status">正在核对聚水潭最新详情…</p>}
     {tab==='order'?<DesktopAfterSalesOrder snapshot={selected.snapshot} images={currentDocumentImages} onOpenSale={()=>showSale(selected)} onReadDiscount={()=>readDiscount(selected)}/>
     :tab==='source'?<DesktopAfterSalesSale snapshot={selected.snapshot} images={currentDocumentImages} onOpenOrder={()=>showOrder(selected)} onShowPanel={showPanel}/>
     :tab==='changes'?<>
      <DesktopAfterSalesHistory record={selected} source busy={busy} loadEarlier={()=>void loadEarlier(selected)}/>
      <details className="ds-tools">
      <summary>聚水潭原始信息</summary>
      <p>来源：{selected.snapshot.sourceCompany} {lookup?.openOriginalSale&&<button type="button" disabled={busy||sourceLoading||!!sourceProblem(selected)} onClick={()=>void run(async()=>{
       void logClick(selected.id,'view_source');
       const {afterSaleId,sourceCompany}=selected.snapshot;
       if(!await lookup.openOriginalSale!({afterSaleId,sourceCompany}))throw new Error('未能打开聚水潭原售后详情');
      })}>查看聚水潭原单</button>}</p>
      <div className="ds-actions" aria-label="聚水潭明细">
       {(Object.keys(SOURCE_PANELS) as DesktopSourcePanel[]).map(kind=><button type="button" key={kind} disabled={busy||sourceLoading}
        aria-pressed={sourcePanel===kind} onClick={()=>showPanel(kind)}>{SOURCE_PANELS[kind].label}</button>)}
      </div>
      <dl>{JST_AFTER_SALES_COLUMNS.filter(k=>k!=='售后单号'&&k!=='内部订单号')
       .map(k=><div key={k}><dt>{k}</dt><dd>{selected.snapshot.fields[k]||'—'}</dd></div>)}</dl>
      </details>
     </>:<>
      <section className="ds-record-section ds-handling" aria-label="处理区">
      {selected.closed?<div className="ds-closed-summary">
       <strong>已完结</strong>
       <p>{selected.closed.actorName||'系统'} · {formatSourceTime(selected.closed.createdAt)}</p>
       <p className="ds-pre">{selected.closed.reason}</p>
      </div>:<>
       <div className="ds-actions ds-quick-handling" aria-label="快捷处理">
        {selected.workspaceState==='tear'
         ?<span>等待仓储部撕单</span>
         :<button type="button" disabled={busy||captureStatus?.pending} onClick={()=>void sendTear(selected)}>撕单</button>}
        {actionStatus&&<small role="status">{actionStatus}</small>}
       </div>
       <label>本次处理记录<textarea disabled={busy} value={note} maxLength={4000} onChange={e=>{dirty.current=true;setNote(e.target.value);}} placeholder="写下处理进展、结果和下一步" rows={3}/></label>
       {bridge&&<div className="ds-actions ds-capture-actions">
        <button type="button" disabled={busy||captureStatus?.pending} onClick={()=>void takeScreenshot(selected)}><Camera size={15}/>截图</button>
        {captureStatus?.id===selected.id&&<small role="status">{captureStatus.text}</small>}
       </div>}
       {pendingFiles.length>0&&<div className="ds-evidence-list" aria-label="本次截图">
        {pendingFiles.map(file=><AfterSalesEvidence key={file.id} saleId={selected.id} file={file} onOpen={()=>void openEvidence(selected,file)}/>)}
       </div>}
       <div className="ds-columns">
        <label>下次跟进时间<input disabled={busy} type="datetime-local" value={nextAt} onChange={e=>{dirty.current=true;setNextAt(e.target.value);}}/></label>
        <label>下次跟进人<select disabled={busy} value={owner} onChange={e=>{dirty.current=true;setOwner(e.target.value);}}>
         <option value="">默认提醒我</option>
         {followPeople.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}
        </select></label>
       </div>
       <div className="ds-actions">
        <button type="button" className="primary" disabled={busy||!note.trim()||captureStatus?.pending} onClick={()=>void save()}>保存跟进</button>
        <button type="button" className="ds-close-case" disabled={busy||captureStatus?.pending||closeReason!==null} onClick={()=>{void logClick(selected.id,'start_close');setNotifyOpen(false);setCloseReason('');}}>完结</button>
        <button type="button" disabled={busy||notifyOpen} onClick={()=>{void logClick(selected.id,'open_notice');setCloseReason(null);setNotifyOpen(true);}}>通知其他部门处理</button>
       </div>
       {closeReason!==null&&<div className="ds-close-form">
        <label>完结理由<textarea autoFocus rows={3} maxLength={1000} disabled={busy} value={closeReason} onChange={e=>setCloseReason(e.target.value)}/></label>
        <div className="ds-actions"><button type="button" disabled={busy} onClick={()=>{void logClick(selected.id,'cancel_close');setCloseReason(null);}}>取消</button>
         <button type="button" className="primary" disabled={busy||!closeReason.trim()} onClick={confirmClose}>确认完结</button></div>
       </div>}
       {notifyOpen&&<div className="ds-close-form ds-notify-form">
        <div className="ds-person-search">
         <label>搜索人名<input value={personSearch} disabled={busy} onChange={e=>{setPersonSearch(e.target.value);setRecipient('');}} placeholder="输入通知对象姓名"/></label>
         <button type="button" disabled={busy} onClick={()=>{void logClick(selected.id,'choose_people');setBrowsePeople(true);setPersonSearch('');setDepartmentFilter('');setRecipient('');}}>选择人</button>
        </div>
        {browsePeople&&!nameQuery&&<label>选择部门<select value={departmentFilter} disabled={busy}
         onChange={e=>{void logClick(selected.id,'select_department');setDepartmentFilter(e.target.value);setRecipient('');}}>
         <option value="">全部部门</option>
         {[...departments].map(([id,name])=><option key={id} value={id}>{name}</option>)}
        </select></label>}
        {(browsePeople||nameQuery)&&<label>通知对象<select value={recipient} disabled={busy} onChange={e=>{if(e.target.value)void logClick(selected.id,'select_recipient');setRecipient(e.target.value);}}>
         <option value="">{peopleByDepartment.size?'按部门选择接收人':'没有匹配的人员'}</option>
         {[...peopleByDepartment].map(([department,people])=><optgroup key={department} label={department}>
          {people.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}
         </optgroup>)}
        </select></label>}
        <label>交接说明<textarea rows={2} disabled={busy} maxLength={500} value={message} onChange={e=>setMessage(e.target.value)}/></label>
        <div className="ds-actions"><button type="button" disabled={busy} onClick={()=>{void logClick(selected.id,'cancel_notice');setNotifyOpen(false);}}>取消</button>
         <button type="button" className="primary" disabled={busy||!recipient||!message.trim()} onClick={()=>void sendNotice(selected)}>发送通知</button></div>
       </div>}
      </>}
      </section>
      <DesktopAfterSalesHistory record={selected} source={false} busy={busy} loadEarlier={()=>void loadEarlier(selected)} hideDraftPreviews={!selected.closed} onOpenFile={file=>void openEvidence(selected,file)}/>
     </>}
    </section></div>}

  {portal&&bridge&&<div className="ds-native-overlay" role="dialog" aria-modal="true" aria-label={portal==='source'?'聚水潭售后':'售后录像回放'}><div className="ds-native-title"><strong>{portal==='source'?'聚水潭售后':'售后录像回放'}</strong><span>{portal==='assistant-video'?'选择一段录像点「预览」，由聚水潭 ERP 助手播放。':''}</span>
   {portal==='source'&&<button type="button" onClick={()=>void bridge.refresh().catch(e=>setError(errorMessage(e)))}>刷新聚水潭</button>}
   <button type="button" onClick={()=>setPortal(null)}>{portal==='source'?'关闭原页面':portal==='assistant-video'?'关闭录像列表':'关闭录像'}</button>
  </div><div className="ds-viewport" ref={viewport}/></div>}
  {evidencePreview&&<DesktopAfterSalesPopup title={evidencePreview.name} onClose={()=>setEvidencePreview(null)}>
   <img className="ds-large-evidence" src={evidencePreview.url} alt={evidencePreview.name}/>
  </DesktopAfterSalesPopup>}
 </div>;
}
