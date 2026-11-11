import {useEffect,useState} from 'react';
import type {DesktopSaleArchive} from '@kudesi/shared';
import {api} from '../../api/client';

type EvidenceFile=DesktopSaleArchive['files'][number];
const timeFormat=new Intl.DateTimeFormat('zh-CN',{
  timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'medium',hour12:false,
});
function formatTime(value:string){
  const timestamp=Date.parse(value);
  return Number.isFinite(timestamp)?timeFormat.format(timestamp):'时间未知';
}

export function DesktopAfterSalesHistory({record,source,busy,loadEarlier,onOpenFile,hideDraftPreviews=false,fileBase}:{
  record:DesktopSaleArchive;
  source:boolean;
  busy:boolean;
  loadEarlier:()=>void;
  onOpenFile?:(file:EvidenceFile)=>void;
  hideDraftPreviews?:boolean;
  fileBase?:string;
}){
  const sorted=[...record.events].sort((a,b)=>b.id-a.id);
  const linked=new Set(sorted.filter(event=>event.kind!=='file').flatMap(event=>event.fileIds??[]));
  const drafts=new Set(hideDraftPreviews?record.pendingFileIds:[]);
  const events=sorted.filter(event=>['snapshot','source_change','source_read'].includes(event.kind)===source);
  const mapped=new Set(sorted.flatMap(event=>event.fileIds??[]));
  const files=new Map(record.files.map(file=>[file.id,file]));
  const earlyFiles=record.files.filter(file=>!mapped.has(file.id));
  const thumbnails=(items:EvidenceFile[])=>items.length>0&&onOpenFile&&<div className="ds-evidence-list" aria-label="售后凭证">
    {items.map(file=><AfterSalesEvidence key={file.id} saleId={record.id} file={file} fileBase={fileBase} onOpen={()=>onOpenFile(file)}/>)}
  </div>;
  return <section className="ds-record-section ds-case-history" aria-label={source?'字段变更历史':'历史处理记录'}>
    <div className="ds-history-heading">
      <h4>{source?'字段变更历史':'历史处理记录'}</h4>
      {source&&<small>最近读取 {formatTime(record.snapshot.capturedAt)}</small>}
    </div>
    {!events.length&&<p>{source?'暂无读取记录':'暂无处理记录'}</p>}
    {source&&events.length>0&&<table className="ds-change-table">
      <thead><tr><th scope="col">字段</th><th scope="col">原值</th><th scope="col">新值</th></tr></thead>
      {events.map(event=><tbody key={event.id}>
        <tr className="ds-read-heading"><th scope="rowgroup" colSpan={3}>
          <span>{formatTime(event.createdAt)} · {event.actorName||'系统'}</span>
          <span>{event.changes?.length ? event.changes.length+' 项变更' : event.content}</span>
        </th></tr>
        {event.changes?.map(change=><tr key={change.field}>
          <th scope="row">{change.field}</th>
          <td>{change.before||'（空）'}</td><td>{change.after||'（空）'}</td>
        </tr>)}
      </tbody>)}
    </table>}
    {!source&&<ol className="ds-record-history">
      {events.map((event,index)=>{
        const attached=(event.fileIds??[]).flatMap(id=>{
          if(event.kind==='file'&&(linked.has(id)||drafts.has(id)))return [];
          const file=files.get(id);
          return file?[file]:[];
        });
        return <li key={event.id}>
          <div className="ds-record-byline">
            {index===0&&<strong>最近一次</strong>}
            <strong>{event.action||(event.kind==='closed'?'完结售后':event.kind==='file'?'截图凭证':'处理记录')}</strong>
            <span title={event.actorId?'账号 ID '+event.actorId:undefined}>
              {event.actorName||(event.actorId?'账号 '+event.actorId:'系统')} · {formatTime(event.createdAt)}
            </span>
          </div>
          {event.content&&<p>{event.content}</p>}
          {(event.nextAt||event.nextOwnerName)&&<small className="ds-record-byline">
            {event.nextAt&&<span>下次跟进 {formatTime(event.nextAt)}</span>}
            {event.nextOwnerName&&<span>跟进人 {event.nextOwnerName}</span>}
          </small>}
          {thumbnails(attached)}
        </li>;
      })}
    </ol>}
    {!source&&earlyFiles.length>0&&<details className="ds-earlier-evidence">
      <summary>早期凭证 · {earlyFiles.length} 张</summary>
      {thumbnails(earlyFiles)}
    </details>}
    {record.nextEventsBefore&&<button type="button" disabled={busy} onClick={loadEarlier}>加载更早记录</button>}
  </section>;
}

export function AfterSalesEvidence({saleId,file,onOpen,fileBase}:{
  saleId:number;file:EvidenceFile;onOpen:()=>void;fileBase?:string;
}){
  const [thumbnail,setThumbnail]=useState('');
  const image=file.mime.startsWith('image/');
  useEffect(()=>{
    if(!image)return;
    let active=true;
    void api<{url:string}>((fileBase??'/desktop-after-sales/'+saleId)+'/files/'+file.id+'/url')
      .then(result=>{if(active)setThumbnail(result.url);}).catch(()=>undefined);
    return()=>{active=false;};
  },[saleId,file.id,image,fileBase]);
  return <button type="button" className="ds-evidence" onClick={onOpen} aria-label={'查看凭证 '+file.name}>
    {thumbnail?<img src={thumbnail} alt="" loading="lazy" onError={()=>setThumbnail('')}/>:<span>{file.name}</span>}
  </button>;
}
