import { useCallback, useEffect, useState } from 'react';
import { Computer, RefreshCw, ShieldCheck, Store } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { DocumentsPage } from './DocumentsPage';
import { Shops } from './SessionShops';
import { SessionDevices } from './SessionDevices';
import { SessionAudit } from './SessionAudit';
import { maintenanceApi, sessionApi, type DeviceRow } from './sessionApi';
import { maintenanceRemoteApi, remoteApi } from './remote/remoteApi';
import './sessionManager.css';

export { Shops } from './SessionShops';
export function StoreWithdrawalPage() { return <SessionManagerPage/>; }
export function SessionManagerPage({maintenance=false}: {maintenance?:boolean}) {
  const {can}=useAuth();
  const [tab,setTab]=useState<'shops'|'devices'|'audit'|'records'>('shops');
  const [devices,setDevices]=useState<DeviceRow[]>([]),[error,setError]=useState('');
  const client=maintenance?maintenanceApi:sessionApi, remoteClient=maintenance?maintenanceRemoteApi:remoteApi;
  const managePermission=maintenance?'resource.company-store-maintenance.manage':'finance.session.manage';
  const remotePermission=maintenance?'resource.company-store-maintenance.remote':'finance.session.remote';
  const load=useCallback(()=>client.devices().then(d=>{setDevices(d);setError('');}).catch(e=>setError(e.message)),[client]);
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),5000);return()=>clearInterval(timer);},[load]);
  const active=devices.filter(d=>d.status==='active'), online=active.filter(d=>d.online).length;
  return <section className="session-manager">
    <header className="session-hero"><div><span>{maintenance?'OA 资料 / 公司店铺维护':'经营财务 / 店铺提现'}</span><h1>{maintenance?'公司店铺维护':'店铺提现登录管理'}</h1><p>{maintenance?'统一维护公司店铺的独立登录环境、授权电脑和远程操作记录。':'统一维护多平台店铺登录状态和授权电脑，为店铺提现提供安全、稳定的登录环境。'}</p></div>
      <div className={`session-agent ${online?'online':''}`}><i/><div><strong>{online} 台在线 / {active.length} 台授权</strong><small>{active.length?'店铺任务将发送到各自绑定的负责电脑':'请先生成绑定码并授权 Windows 助手'}</small></div><button type="button" aria-label="刷新电脑状态" onClick={()=>void load()}><RefreshCw size={15}/></button></div>
    </header>
    <nav className="session-tabs" aria-label="店铺管理页签">{([{id:'shops',label:'登录状态',Icon:Store},{id:'devices',label:'授权电脑',Icon:Computer},{id:'audit',label:'操作日志',Icon:ShieldCheck}] as const).map(({id,label,Icon})=><button type="button" key={id} className={tab===id?'active':''} aria-current={tab===id?'page':undefined} onClick={()=>setTab(id)}><Icon size={16}/>{label}</button>)}
      {!maintenance&&<button type="button" className={tab==='records'?'active session-records-tab':'session-records-tab'} onClick={()=>setTab('records')}>提现记录</button>}
    </nav>
    {error&&<div role="alert" className="session-alert">{error}</div>}
    {tab==='shops'&&<Shops client={client} maintenance={maintenance}/>}
    {tab==='devices'&&<SessionDevices client={client} remoteClient={remoteClient} manage={can(managePermission)} managePermission={managePermission} onChanged={()=>void load()}/>}
    {tab==='audit'&&<SessionAudit client={client} remoteClient={remoteClient} managePermission={managePermission} remotePermission={remotePermission}/>}
    {!maintenance&&tab==='records'&&<DocumentsPage scope="withdrawal" embedded/>}
  </section>;
}
