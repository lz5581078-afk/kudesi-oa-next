import {useEffect,useState} from 'react';
import {AlertTriangle,CheckCircle2} from 'lucide-react';
import type {DesktopCollectionSource} from '@kudesi/shared';
import {api} from '../../api/client';
export const COLLECTION_LABELS:Record<DesktopCollectionSource['health'],string>={stopped:'最新售后采集已停止',failed:'最新售后采集失败',starting:'正在首次采集，尚未确认最新数据',waiting:'最新售后采集已断开，等待客户端连接',stale:'最新售后数据已滞后',healthy:'最新售后采集正常'};
export function DesktopCollectionStatus(){
 const [sources,setSources]=useState<DesktopCollectionSource[]|null>(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;async function load(){try{const result=await api<DesktopCollectionSource[]>('/desktop-after-sales-collection');if(!Array.isArray(result))throw new Error('采集状态返回异常');if(active){setSources(result);setError('');}}catch(e){if(active)setError((e as Error).message);}}
  void load();const timer=setInterval(()=>void load(),5000);return()=>{active=false;clearInterval(timer);};
 },[]);
 const warning=!!error||!sources?.length||sources.some(s=>s.health!=='healthy');
 return <section className={`ds-collection ${warning?'ds-collection-warning':'ds-collection-ok'}`} role={warning?'alert':'status'} aria-live="polite">
  {warning?<AlertTriangle size={15}/>:<CheckCircle2 size={15}/>}
  <div>{error?<><strong>无法读取采集状态</strong><span> · {error}</span></>:sources===null?<strong>正在核实售后采集状态…</strong>:!sources.length?<span>等待登录聚水潭后开始自动采集</span>:sources.map(s=><div key={s.id}><strong>{s.sourceCompany} · {COLLECTION_LABELS[s.health]}</strong><span> · 最后成功 {s.lastSuccessAt?new Date(s.lastSuccessAt).toLocaleString():'暂无'}{s.lastError?` · ${s.lastError}`:''}</span></div>)}</div>
 </section>;
}
