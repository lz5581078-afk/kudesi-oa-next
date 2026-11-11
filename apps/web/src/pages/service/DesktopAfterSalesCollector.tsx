import {useEffect} from 'react';
import type {DesktopCollectionLease,DesktopCollectionSource} from '@kudesi/shared';
import {useAuth} from '../../auth/AuthContext';
import {api,tokenStore} from '../../api/client';
import type {DesktopBridge} from './desktopBridge';

const BASE='/desktop-after-sales-collection';
type CollectionPreferences=NonNullable<Awaited<ReturnType<DesktopBridge['preferences']>>['collection']>;

function canCollect(prefs:CollectionPreferences|undefined,companyId:number,sourceCompany?:string){
 if(!prefs)return false;
 const paused=prefs.paused??(!prefs.enabled&&!!prefs.sourceCompany);
 return !paused&&(!prefs.companyId||prefs.companyId===companyId)&&
  (!sourceCompany||!prefs.sourceCompany||prefs.sourceCompany===sourceCompany);
}

/** The hidden renderer collects current rounds for the active OA identity only. */
export function DesktopAfterSalesCollector(){
 const {user,can,loading}=useAuth();
 useEffect(()=>{
  const bridge=window.oaDesktop;
  const readPage=bridge?.latest,prepare=bridge?.prepareLatest;
  if(loading||!user||!can('after-sales.workspace.view')||!bridge||!readPage||!prepare)return;
  const {companyId}=user;
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
  const identity=tokenStore.get();
  const active=()=>!stopped&&tokenStore.get()===identity;
  const request=async<T,>(path:string,body?:unknown)=>{
   if(!active())throw new Error('采集身份已变化');
   return api<T>(path,body===undefined?{}:{body});
  };

  const tick=async()=>{
   try{
    const {collection:prefs}=await bridge.preferences();
    if(!active()||!prefs||!canCollect(prefs,companyId))return;
    const status=await bridge.jushuitanStatus?.();
    if(status&&(status.state!=='authenticated'||!status.sourceCompany||status.busy))return;
    if(!canCollect(prefs,companyId,status?.sourceCompany))return;

    const sources=await request<DesktopCollectionSource[]>(BASE);
    const boundCompany=status?.sourceCompany||prefs.sourceCompany;
    let sourceId=sources.find(s=>s.enabled&&s.sourceCompany===boundCompany)?.id;
    if(sources.length&&status?.sourceCompany&&sourceId===undefined)return;
    const mustJoin=!prefs.enabled||sourceId===undefined||!!(bridge.joinCollection&&!prefs.companyId);
    if(status||mustJoin){
     const {sourceCompany}=await prepare();
     if(!active()||!sourceCompany||(status&&sourceCompany!==status.sourceCompany)||!canCollect(prefs,companyId,sourceCompany))return;
     if(mustJoin){
      if(!bridge.joinCollection||(sources.length&&!sources.some(s=>s.enabled&&s.sourceCompany===sourceCompany)))return;
      const joined=await request<{id:number;enabled:boolean}|null>(`${BASE}/join`,{sourceCompany});
      if(!joined?.enabled||!active()||!await bridge.joinCollection({sourceCompany,companyId}))return;
      sourceId=joined.id;
     }
    }
    if(sourceId===undefined)return;

    const round=`${BASE}/${sourceId}`;
    const lease=await request<DesktopCollectionLease|null>(`${round}/claim`,{clientId:prefs.clientId});
    if(!lease)return;
    const credentials={token:lease.token};
    const release=()=>request(`${round}/yield`,credentials).catch(()=>undefined);
    let heartbeatError:unknown=null;
    const heartbeat=setInterval(()=>{
     void request(`${round}/heartbeat`,credentials).catch(error=>{heartbeatError=error;});
    },25000);
    try{
     for(let page=lease.page;active();page++){
      if(heartbeatError)throw heartbeatError;
      const current=await bridge.preferences();
      if(!canCollect(current.collection,companyId,lease.sourceCompany)){await release();break;}
      const result=await readPage({
       kind:'current',field:'afterSaleId',value:'',sourceCompany:lease.sourceCompany,
       from:lease.from,until:lease.until,page,sourceColumns:true,
      });
      if(!active())return;
      if(heartbeatError)throw heartbeatError;
      if(result.hasNext===null)throw new Error('无法确认本轮最新售后是否完整');
      const latestPreferences=await bridge.preferences();
      if(!canCollect(latestPreferences.collection,companyId,lease.sourceCompany)){await release();break;}
      const completed=!!lease.firstPageOnly||!result.hasNext;
      const commit=await request<{completed:boolean}>(`${round}/commit`,{...credentials,records:result.records,page,completed});
      if(completed||commit?.completed)break;
     }
    }catch(error){
     if(!active())return;
     const message=error instanceof Error?error.message:'本轮采集失败';
     if(message.includes('已让出本机后台采集')||message.includes('本机最新采集已暂停'))await release();
     else await request(`${round}/fail`,{...credentials,message:message.slice(0,500)}).catch(()=>undefined);
    }finally{clearInterval(heartbeat);}
   }catch{/* The visible workbench checks server health separately. */}
   finally{if(active())timer=setTimeout(()=>void tick(),5000);}
  };

  void tick();
  return()=>{stopped=true;if(timer)clearTimeout(timer);};
 },[user?.id,user?.companyId,loading,can]);
 return null;
}
