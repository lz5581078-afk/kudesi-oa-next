import {useEffect,useState} from 'react';
import {useParams} from 'react-router-dom';
import type {DesktopSaleArchive,DesktopSaleClick,DesktopSaleEvent} from '@kudesi/shared';
import {api,tokenStore} from '../../api/client';
import {DesktopAfterSalesHistory} from './DesktopAfterSalesHistory';
import './desktopAfterSales.css';
/** Every request is checked against a same-company, single-record grant on the server. */
export function DesktopAfterSalesSharedPage(){
 const {id}=useParams();const [record,setRecord]=useState<DesktopSaleArchive|null>(null),[note,setNote]=useState(''),[report,setReport]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [closeReason,setCloseReason]=useState<string|null>(null);
 const base=`/desktop-after-sales-shared/${id}`;
 async function logClick(click:DesktopSaleClick){
  const identity=tokenStore.get();
  try{
   const event=await api<DesktopSaleEvent>(base+'/activity',{body:{click}});
   if(tokenStore.get()!==identity||event.kind!=='activity')return;
   setRecord(current=>current?.id===Number(id)&&!current.events.some(item=>item.id===event.id)
    ?{...current,events:[event,...current.events]}:current);
  }catch(error){
   if(tokenStore.get()===identity)setError('售后操作日志保存失败 · '+(error as Error).message);
  }
 }
 useEffect(()=>{let active=true;api<DesktopSaleArchive>(base).then(v=>{if(active){setRecord(v);setReport(v.report??'');void logClick('open_shared');}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[base]);
 async function save(){setBusy(true);setError('');try{await logClick('click_reply');const v=await api<DesktopSaleArchive>(`${base}/records`,{body:{content:note}});setRecord(v);setNote('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function closeTear(){
  const reason=closeReason?.trim();
  if(!record||!reason)return;
  if(!confirm('确认撕单处理完成并完结这笔 OA 售后？')){void logClick('cancel_close');return;}
  setBusy(true);setError('');
  try{
   await logClick('confirm_close');
   const result=await api<DesktopSaleArchive>(base+'/close-tear',{body:{version:record.version,note,reason}});
   setRecord(result);setNote('');setCloseReason(null);
  }catch(error){setError((error as Error).message);}
  finally{setBusy(false);}
 }
 async function loadEarlier(){
  if(!record?.nextEventsBefore)return;
  void logClick('load_history');
  setBusy(true);
  try{
   const result=await api<DesktopSaleArchive>(base+'/events?before='+record.nextEventsBefore);
   const events=new Map(record.events.map(event=>[event.id,event]));
   for(const event of result.events)events.set(event.id,event);
   setRecord({...record,events:[...events.values()],nextEventsBefore:result.nextEventsBefore});
  }catch(error){setError((error as Error).message);}
  finally{setBusy(false);}
 }
 async function openEvidence(file:DesktopSaleArchive['files'][number]){
  void logClick('view_file');
  try{
   const result=await api<{url:string}>(base+'/files/'+file.id+'/url');
   window.open(result.url,'_blank','noopener');
  }catch(error){setError((error as Error).message);}
 }
 return <div className="desktop-sales ds-shared"><h2>售后协作 · {record?.snapshot.afterSaleId??'加载中'}</h2>{error&&<div role="alert" className="ds-error">{error}</div>}{record&&<>
  <p>内部订单 {record.snapshot.internalOrderId} · {record.storeName} · 负责人 {record.ownerName||'未分配'}</p><h3>{record.progress||'尚未填写处理进度'}</h3>
  <details open><summary onClick={()=>void logClick('view_source')}>售后资料</summary><dl>{Object.entries(record.snapshot.fields).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v||'—'}</dd></div>)}</dl></details>
  {record.closed?<div className="ds-closed-summary"><strong>已完结</strong><p>{record.closed.reason}</p></div>:<>
   <label>{record.workspaceState==='tear'?'撕单处理记录':'本部门处理记录'}<textarea disabled={busy} value={note} maxLength={4000} rows={3} onChange={e=>setNote(e.target.value)}/></label>
   <div className="ds-actions">
    <button className="primary" disabled={busy||!note.trim()} onClick={()=>void save()}>提交处理记录</button>
    {record.canCloseTear&&<button type="button" disabled={busy||closeReason!==null} onClick={()=>{void logClick('start_close');setCloseReason('');}}>撕单已处理，完结售后</button>}
   </div>
   {closeReason!==null&&<div className="ds-close-form">
    <label>完结理由<textarea autoFocus disabled={busy} maxLength={1000} rows={2} value={closeReason} onChange={e=>setCloseReason(e.target.value)}/></label>
    <div className="ds-actions">
     <button type="button" disabled={busy} onClick={()=>{void logClick('cancel_close');setCloseReason(null);}}>取消</button>
     <button type="button" className="primary" disabled={busy||!closeReason.trim()} onClick={()=>void closeTear()}>确认完结</button>
    </div>
   </div>}
  </>}
  {!record.closed&&record.workspaceState!=='tear'&&<><label>跟踪报告<textarea disabled={busy} value={report} maxLength={8000} rows={5} onChange={e=>setReport(e.target.value)}/></label><button disabled={busy} onClick={async()=>{setBusy(true);try{const value=await api<DesktopSaleArchive>(`${base}/metadata`,{body:{version:record.version,priority:record.priority??0,rowColor:record.rowColor??null,report}});setRecord(value);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>保存跟踪报告</button></>}
  <DesktopAfterSalesHistory record={record} source={false} busy={busy} loadEarlier={()=>void loadEarlier()}
   fileBase={base} onOpenFile={file=>void openEvidence(file)}/>
  <details className="ds-tools"><summary onClick={()=>void logClick('view_source_history')}>聚水潭字段变更</summary>
   <DesktopAfterSalesHistory record={record} source busy={busy} loadEarlier={()=>void loadEarlier()}/>
  </details>
 </>}</div>;
}
