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
      const result=await orgApi.staffTestNotice(staff.id,requestId.current);
      if(alive.current){started.current=Date.now();setJob(result);}
    } catch(e){if(alive.current)setError(errorText(e));}
    finally{if(alive.current)setBusy(false);}
  }
  return <div className="modal-backdrop" role="presentation"><section className="modal card small" role="dialog" aria-label="发送飞书测试通知">
    <div className="modal-head"><strong>发送测试通知给 {staff.name}</strong></div>
    <div className="modal-body">
      <p>由通知助手发给此员工绑定的飞书账号，同时保留一条 OA 站内通知。</p>
      <div className="notice">OA 飞书通知测试<p>这是一条 OA 测试通知，用于确认 OA 与你绑定的飞书账号之间的消息通道是否正常，无需办理业务。</p></div>
      {!job&&!status?.canTest&&<p role="status">{status?.testBlockedReason??'请先刷新人员的飞书绑定状态'}</p>}
      {job&&<p role="status">{job.message}{['pending','sending','paused'].includes(job.status)&&'。可稍后刷新查询，请勿重复发送。'}</p>}
      {error&&<p role="alert" className="notice error">{error}</p>}
    </div>
    <div className="modal-foot">
      <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
      {job?<button type="button" className="secondary-button" onClick={()=>void check()}>刷新发送状态</button>:<button type="button" className="primary-button" disabled={busy||!status?.canTest} onClick={()=>void send()}>{busy?'正在提交…':'发送测试通知'}</button>}
    </div>
  </section></div>;
}
