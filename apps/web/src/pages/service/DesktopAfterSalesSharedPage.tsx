import {useEffect,useState} from 'react';
import {useParams} from 'react-router-dom';
import type {DesktopSaleArchive} from '@kudesi/shared';
import {api} from '../../api/client';
import './desktopAfterSales.css';
/** Every request is checked against a same-company, single-record grant on the server. */
export function DesktopAfterSalesSharedPage(){
 const {id}=useParams();const [record,setRecord]=useState<DesktopSaleArchive|null>(null),[note,setNote]=useState(''),[report,setReport]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const base=`/desktop-after-sales-shared/${id}`;
 useEffect(()=>{let active=true;api<DesktopSaleArchive>(base).then(v=>{if(active){setRecord(v);setReport(v.report??'');}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[base]);
 async function save(){setBusy(true);setError('');try{const v=await api<DesktopSaleArchive>(`${base}/records`,{body:{content:note}});setRecord(v);setNote('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <div className="desktop-sales ds-shared"><h2>售后协作 · {record?.snapshot.afterSaleId??'加载中'}</h2>{error&&<div role="alert" className="ds-error">{error}</div>}{record&&<>
  <p>内部订单 {record.snapshot.internalOrderId} · {record.storeName} · 负责人 {record.ownerName||'未分配'}</p><h3>{record.progress||'尚未填写处理进度'}</h3>
  <details open><summary>售后资料</summary><dl>{Object.entries(record.snapshot.fields).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v||'—'}</dd></div>)}</dl></details>
  <label>本部门处理记录<textarea value={note} maxLength={4000} rows={4} onChange={e=>setNote(e.target.value)}/></label><button className="primary" disabled={busy||!note.trim()} onClick={()=>void save()}>提交处理记录</button>
  <label>跟踪报告<textarea disabled={busy} value={report} maxLength={8000} rows={5} onChange={e=>setReport(e.target.value)}/></label><button disabled={busy} onClick={async()=>{setBusy(true);try{const value=await api<DesktopSaleArchive>(`${base}/metadata`,{body:{version:record.version,priority:record.priority??0,rowColor:record.rowColor??null,report}});setRecord(value);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>保存跟踪报告</button><h3>处理与变更历史</h3><ol className="ds-history">{record.events.map(e=><li key={e.id}><small>{e.actorName} · {new Date(e.createdAt).toLocaleString()}</small><p>{e.content}</p></li>)}</ol>{record.nextEventsBefore&&<button disabled={busy} onClick={async()=>{setBusy(true);try{const value=await api<DesktopSaleArchive>(`${base}/events?before=${record.nextEventsBefore}`);setRecord({...record,events:[...record.events,...value.events],nextEventsBefore:value.nextEventsBefore});}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>加载更早处理历史</button>}
 </>}</div>;
}
