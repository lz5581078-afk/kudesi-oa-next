import {useEffect,useState} from 'react';
import {AlertTriangle,CheckCircle2,RefreshCw} from 'lucide-react';
import type {DesktopCollectionSource} from '@kudesi/shared';
import {api} from '../../api/client';
export const COLLECTION_LABELS:Record<DesktopCollectionSource['health'],string>={stopped:'最新售后采集已停止',failed:'最新售后采集失败',starting:'正在首次采集，尚未确认最新数据',waiting:'最新售后采集已断开，等待客户端连接',stale:'最新售后数据已滞后',healthy:'最新售后采集正常'};
export function DesktopCollectionStatus({onSettings,onRefresh}:{onSettings:()=>void;onRefresh?:()=>void}){
 const [sources,setSources]=useState<DesktopCollectionSource[]|null>(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;async function load(){try{const result=await api<DesktopCollectionSource[]>('/desktop-after-sales-collection');if(!Array.isArray(result))throw new Error('采集状态返回异常');if(active){setSources(result);setError('');}}catch(e){if(active)setError((e as Error).message);}}
  void load();const timer=setInterval(()=>{void load();onRefresh?.();},5000);return()=>{active=false;clearInterval(timer);};
 },[onRefresh]);
 const warning=!!error||!sources?.length||sources.some(s=>s.health!=='healthy');
 return <section className={`ds-collection ${warning?'ds-collection-warning':'ds-collection-ok'}`} role={warning?'alert':'status'} aria-live="polite">
  {warning?<AlertTriangle size={22}/>:<CheckCircle2 size={22}/>}
  <div>{error?<><strong>无法确认最新售后采集状态</strong><p>{error}。当前列表可能不是最新数据，请检查 OA 连接。</p></>:sources===null?<strong>正在核实最新售后采集状态…</strong>:!sources.length?<><strong>最新售后采集尚未配置</strong><p>请连接聚水潭并启用最新补采。历史查询由当前电脑操作。</p></>:sources.map(s=><div key={s.id}><strong>{s.sourceCompany} · {COLLECTION_LABELS[s.health]}</strong><p>最后成功：{s.lastSuccessAt?new Date(s.lastSuccessAt).toLocaleString():'尚无成功记录'} · 查询间隔 {s.intervalSeconds} 秒{s.lastError?` · ${s.lastError}`:''}{s.health==='stale'?' · 请确认至少一台已登录客户端保持在线。':''}</p></div>)}</div>
  <button onClick={onSettings}><RefreshCw size={14}/> 检查采集连接</button>
 </section>;
}
