import {useEffect} from 'react';
import type {DesktopCollectionLease,DesktopCollectionSource} from '@kudesi/shared';
import {useAuth} from '../../auth/AuthContext';
import {api,tokenStore} from '../../api/client';
import './desktopBridge';
const BASE='/desktop-after-sales-collection';
/** Hidden ordinary OA renderer. Only latest rounds are eligible; historical searches never enter this loop. */
export function DesktopAfterSalesCollector(){
 const {user,can,loading}=useAuth();
 useEffect(()=>{
  const bridge=window.oaDesktop;
  if(loading||!user||!can('after-sales.workspace.view')||!bridge?.latest||!bridge.prepareLatest)return;
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
  const identity=tokenStore.get();
  const active=()=>!stopped&&tokenStore.get()===identity;
  const request=async<T,>(path:string,body?:unknown)=>{if(!active())throw new Error('采集身份已变化');return api<T>(path,body===undefined?{}:{body});};
  async function tick(){
   try{
    const prefs=await bridge!.preferences();
    if(!active()||!prefs.collection||(prefs.collection.companyId&&prefs.collection.companyId!==user!.companyId))return;
    const sources=await request<DesktopCollectionSource[]>(BASE);
    let sourceId=sources.find(s=>s.enabled&&s.sourceCompany===prefs.collection?.sourceCompany)?.id;
    if(!prefs.collection.enabled||sourceId===undefined||(bridge!.joinCollection&&!prefs.collection.companyId)){
     if(!bridge!.joinCollection)return;
     const {sourceCompany}=await bridge!.prepareLatest!();
     if(!active()||!sourceCompany||(prefs.collection.sourceCompany&&prefs.collection.sourceCompany!==sourceCompany))return;
     if(sources.length&&!sources.some(s=>s.enabled&&s.sourceCompany===sourceCompany))return;
     if(!sources.length&&prefs.collection.sourceCompany)return;
     const joined=await request<{id:number;enabled:boolean}|null>(`${BASE}/join`,{sourceCompany});
     if(!joined?.enabled||!active()||!await bridge!.joinCollection({sourceCompany,companyId:user!.companyId}))return;
     sourceId=joined.id;
    }
    const round=`${BASE}/${sourceId}`;
    const lease=await request<DesktopCollectionLease|null>(`${round}/claim`,{clientId:prefs.collection.clientId});if(!lease)return;
    let heartbeatError:Error|null=null;
    const heartbeat=setInterval(()=>{void request(`${round}/heartbeat`,{token:lease.token}).catch(e=>{heartbeatError=e;});},25000);
    try{
     for(let page=lease.page;active();page++){
      if(heartbeatError)throw heartbeatError;
      const current=await bridge!.preferences();if(!current.collection?.enabled)throw new Error('本机最新售后采集已停止，等待其他客户端接续');
      const result=await bridge!.latest!({kind:'current',field:'afterSaleId',value:'',sourceCompany:lease.sourceCompany,from:lease.from,until:lease.until,page});
      if(!active())return;
      if(heartbeatError)throw heartbeatError;
      if(result.hasNext===null)throw new Error('无法确认本轮最新售后是否完整');
      const completed=lease.firstPageOnly||!result.hasNext;
      const resultCommit=await request<{completed?:boolean}>(`${round}/commit`,{token:lease.token,records:result.records,page,completed});
      if(completed||resultCommit?.completed)break;
     }
    }catch(e){if(active())await request(`${round}/fail`,{token:lease.token,message:(e as Error).message.slice(0,500)}).catch(()=>undefined);}
    finally{clearInterval(heartbeat);}
   }catch{/* The visible page polls server health independently; cannot confirm status is never shown as healthy. */}
   finally{if(active())timer=setTimeout(()=>void tick(),5000);}
  }
  void tick();return()=>{stopped=true;if(timer)clearTimeout(timer);};
 },[user?.id,user?.companyId,loading,can]);
 return null;
}
