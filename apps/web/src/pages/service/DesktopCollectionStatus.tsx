import {useEffect,useState} from 'react';
import {AlertTriangle,CheckCircle2,CloudDownload} from 'lucide-react';
import type {DesktopCollectionSource} from '@kudesi/shared';
import {api} from '../../api/client';
export const COLLECTION_LABELS:Record<DesktopCollectionSource['health'],string>={stopped:'最新售后采集已停止',failed:'最新售后采集失败',starting:'正在首次采集，尚未确认最新数据',waiting:'最新售后采集已断开，等待客户端连接',stale:'最新售后数据已滞后',healthy:'最新售后采集正常'};

export function DesktopCollectionStatus(){
 const [sources,setSources]=useState<DesktopCollectionSource[]|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  let active=true,running=false;
  async function load(){
   if(running)return;
   running=true;
   try{const result=await api<DesktopCollectionSource[]>('/desktop-after-sales-collection');if(!Array.isArray(result))throw new Error('采集状态返回异常');if(active){setSources(result);setError('');}}
   catch(e){if(active)setError((e as Error).message);}
   finally{running=false;}
  }
  const refresh=()=>void load();
  const refreshVisible=()=>{if(document.visibilityState==='visible')refresh();};
  refresh();
  const timer=setInterval(refresh,5000);
  window.addEventListener('focus',refresh);
  document.addEventListener('visibilitychange',refreshVisible);
  return()=>{
   active=false;
   clearInterval(timer);
   window.removeEventListener('focus',refresh);
   document.removeEventListener('visibilitychange',refreshVisible);
  };
 },[]);
 const problem=sources?.find(s=>s.enabled&&['failed','stale'].includes(s.health));
 const healthy=sources?.find(s=>s.health==='healthy');
 const last=sources?.reduce<string|null>((latest,s)=>s.lastSuccessAt&&(!latest||s.lastSuccessAt>latest)?s.lastSuccessAt:latest,null);
 if(error||problem)return <div className="ds-sync ds-sync-warning" role="alert">
  <AlertTriangle size={14} aria-hidden="true"/>
  {error?<span>无法获取服务器采集状态，列表仍显示已归档数据。</span>:<>
   <strong>{problem!.sourceCompany} · {COLLECTION_LABELS[problem!.health]}</strong>
   <span>{problem!.lastError||'请检查采集客户端是否在线。'} · 最后成功：{problem!.lastSuccessAt?new Date(problem!.lastSuccessAt).toLocaleString():'暂无'}</span>
  </>}
 </div>;
 const text=!sources?'正在读取服务器采集状态…':!sources.length?'服务器暂无采集来源':healthy?'服务器采集正常':sources.every(s=>!s.enabled)?'服务器采集已暂停':'等待在线客户端采集';
 return <div className="ds-sync" role="status">
  {healthy?<CheckCircle2 size={14} aria-hidden="true"/>:<CloudDownload size={14} aria-hidden="true"/>}
  <span>{text}{last&&` · 最后成功：${new Date(last).toLocaleString()}`}</span>
 </div>;
}