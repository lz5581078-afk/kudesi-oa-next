import { useEffect, useRef, useState } from 'react';
import { orgApi, type StaffDto, type StaffFeishuStatus, type StaffTestNotice } from './orgApi';
import { ApiError } from '../../api/client';

export function StaffFeishuBadge({status}:{status?:StaffFeishuStatus}) {
  const label=!status?'未读取':status.bound===null?'未能确认':status.bound?'已绑定':'未绑定';
  return <span><span className={status?.bound?'pill ok':'pill warn'} title={status?.testBlockedReason??undefined}>{label}</span>
    {status?.bound&&<small className="muted" style={{display:'block'}}>{status.notificationsEnabled?'OA 通知已开启':'OA 通知未开启'}</small>}</span>;
}
function newTestRequestId() {
  if(crypto.randomUUID)return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const errorText=(e:unknown)=>e instanceof ApiError?e.message:'操作失败，请稍后重试';
export function StaffTestNoticeDialog({staff,status,onClose}:{staff:StaffDto;status?:StaffFeishuStatus;onClose:()=>void}) {
  const [title,setTitle]=useState('OA 飞书通知测试'),[body,setBody]=useState('这是一条 OA 测试通知，用于确认 OA 与你绑定的飞书账号之间的消息通道是否正常，无需办理业务。');
  const [preview,setPreview]=useState(false);
  const valid=!!title.trim()&&title.length<=100&&!!body.trim()&&body.length<=2000;
  const [job,setJob]=useState<StaffTestNotice|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const requestId=useRef<string>(),started=useRef(0),alive=useRef(true),readVersion=useRef(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function check() {
    if(!job)return;
    setError('');
    const version=++readVersion.current;
    try {const result=await orgApi.staffTestNoticeStatus(staff.id,job.jobId);if(alive.current&&version===readVersion.current)setJob(result);}
    catch(e){if(alive.current&&version===readVersion.current)setError(errorText(e));}
  }
  useEffect(()=>{
    if(!job||!['pending','sending','paused'].includes(job.status)||Date.now()-started.current>90_000)return;
    const timer=setTimeout(()=>void check(),2500);
    return()=>clearTimeout(timer);
  },[job]);
  async function send() {
    setBusy(true);setError('');
    try {
      requestId.current??=newTestRequestId(); // Retry an uncertain HTTP response with the same request ID.
      const result=await orgApi.staffTestNotice(staff.id,requestId.current,{title:title.trim(),body:body.replace(/\r\n?/g,'\n').trim()});
      if(alive.current){started.current=Date.now();setJob(result);}
    } catch(e){if(alive.current){
      if(e instanceof ApiError&&[400,403,404,429].includes(e.status))requestId.current=undefined;
      setError(errorText(e));
    }}
    finally{if(alive.current)setBusy(false);}
  }
  return <div className="modal-backdrop" role="presentation"><section className="modal card small" role="dialog" aria-label="发送飞书通知">
    <div className="modal-head"><strong>发送飞书通知给 {staff.name}</strong></div>
    <div className="modal-body">
      <p>由通知助手发给此员工绑定的飞书账号，同时保留一条 OA 站内通知。</p>
      {!preview&&!job?<div className="stack">
        <label>消息标题<input aria-label="消息标题" maxLength={100} value={title} onChange={e=>setTitle(e.target.value)} /></label>
        <label>消息正文<textarea aria-label="消息正文" maxLength={2000} rows={6} value={body} onChange={e=>setBody(e.target.value)} /></label>
        <small className="muted">标题 {title.length}/100 · 正文 {body.length}/2000</small>
      </div>:<div className="notice"><strong>{title.trim()}</strong><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{body.trim()}</p></div>}
      {preview&&!job&&<p>接收人：<strong>{staff.name}</strong>。确认后通过通知助手发送以上内容。</p>}
      {requestId.current&&!job&&!busy&&<p>本次提交结果待确认，重试会查询同一条消息的结果。</p>}
      {!job&&!status?.canTest&&<p role="status">{status?.testBlockedReason??'请先刷新人员的飞书绑定状态'}</p>}
      {job&&<p role="status">{job.message}{['pending','sending','paused'].includes(job.status)&&'。可稍后刷新查询，请勿重复发送。'}</p>}
      {error&&<p role="alert" className="notice error">{error}</p>}
    </div>
    <div className="modal-foot">
      <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
      {job?<button type="button" className="secondary-button" onClick={()=>void check()}>刷新发送状态</button>:preview?<>
        <button type="button" className="secondary-button" disabled={busy||!!requestId.current} onClick={()=>setPreview(false)}>返回修改</button>
        <button type="button" className="primary-button" disabled={busy||!status?.canTest||!valid} onClick={()=>void send()}>{busy?'正在提交…':requestId.current?'重试确认发送':'确认发送'}</button>
      </>:<button type="button" className="primary-button" disabled={!status?.canTest||!valid} onClick={()=>{setError('');setPreview(true);}}>预览消息</button>}
    </div>
  </section></div>;
}
