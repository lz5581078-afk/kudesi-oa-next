import {useEffect,useState} from 'react';
import {api,tokenStore} from '../../api/client';
import type {DesktopBridge} from './desktopBridge';

let acceptanceRun:Promise<void>|undefined;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export function DesktopAfterSalesAcceptance({bridge}:{bridge:DesktopBridge}){
 const [message,setMessage]=useState('等待聚水潭连接');
 useEffect(()=>{
  if(acceptanceRun||!bridge.localAcceptancePage)return;
  const read=bridge.localAcceptancePage;
  const identity=tokenStore.get();
  const report=(text:string)=>{
   setMessage(text);
   void bridge.localAcceptanceProgress?.(text).catch(()=>{});
  };
  const assertSession=()=>{if(!identity||identity!==tokenStore.get())throw new Error('本地 OA 登录已变化');};
  acceptanceRun=(async()=>{
   report('已进入售后工作台，等待聚水潭登录状态');
   let sourceCompany='';
   for(let attempt=0;attempt<30;attempt++){
    assertSession();
    const status=await bridge.jushuitanStatus?.();
    if(status?.state==='authenticated'&&status.sourceCompany){sourceCompany=status.sourceCompany;break;}
    if(status?.state==='login_required')throw new Error('聚水潭当前需要登录');
    await pause(1000);
   }
   if(!sourceCompany)throw new Error('无法确认聚水潭登录状态');
   const base='/desktop-after-sales-collection';
   const sources=await api<{id:number;sourceCompany:string}[]>(base);
   const source=sources.find(row=>row.sourceCompany===sourceCompany)??
    (!sources.length?await api<{id:number}|null>(base+'/join',{body:{sourceCompany}}):null);
   if(!source)throw new Error('本地 OA 尚未登记该聚水潭来源');
   const now=Date.now(),until=new Date(now).toISOString(),from=new Date(now-72*60*60_000).toISOString();
   report(`申请时间窗口 ${from} 至 ${until}`);
   const seen=new Set<string>();
   let min='',max='';
   for(let page=1;page<=200;page++){
    assertSession();
    const result=await read({kind:'current',field:'afterSaleId',value:'',sourceCompany,from,until,page,sourceColumns:true});
    assertSession();
    const records=result.records.filter(row=>!seen.has(row.afterSaleId));
    if(records.length){
     const archived=await api<{ids:number[]}>(base+'/'+source.id+'/local',{method:'POST',body:{records}});
     if(archived.ids.length!==records.length)throw new Error('本地 OA 归档条数与提交不一致');
     for(const row of records){
      seen.add(row.afterSaleId);
      const date=row.fields['申请时间']||'';
      if(date&&(!min||date<min))min=date;
      if(date&&(!max||date>max))max=date;
     }
    }
    report(`第 ${page} 页归档 ${records.length} 条，累计 ${seen.size} 条`);
    if(!result.hasNext){report(`采集完成，共 ${page} 页 ${seen.size} 条，申请时间 ${min||'—'} 至 ${max||'—'}`);return;}
    await pause(300);
   }
   throw new Error('达到本地验收页数上限');
  })().catch(error=>report('采集停止，'+String(error?.message||'未知错误').replace(/https?:\/\/\S+/g,'[链接]')));
 },[bridge]);
 return <div role="status">近三天采集验收 · {message}</div>;
}
