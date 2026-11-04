import {type DesktopSaleSnapshot,type AfterSalesField} from '@kudesi/shared';
export function applicationAt(s:DesktopSaleSnapshot):Date|null{
 const m=s.fields['申请时间']?.match(/(\d{4})[-/](\d{2})[-/](\d{2})[\sT]+(\d{2}):(\d{2})(?::(\d{2}))?/);
 if(!m||Number(m[1])<1000)return null;
 const d=new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]??'00'}+08:00`);
 return Number.isFinite(d.getTime())?d:null;
}
const normalize=(key:string,value:string)=>key==='线上状态'?value.replace(/还剩[\s\S]*$/,'').trim():value.trim();
export function sourceChanges(before:DesktopSaleSnapshot,after:DesktopSaleSnapshot){
 const changes:Array<{field:AfterSalesField;before:string;after:string}>=[];
 for(const [field,value] of Object.entries(after.fields)){
  const prior=before.fields[field as AfterSalesField]??'';
  if(normalize(field,prior)!==normalize(field,value??''))changes.push({field:field as AfterSalesField,before:prior,after:value??''});
 }
 return changes;
}
export function collectionHealth(s:{enabled:number|boolean;last_success_at:Date|null;last_failure_at:Date|null;last_error_enc:string|null;lease_until:Date|null;query_from?:Date|null;last_client_seen_at?:Date|null;interval_seconds:number},now=new Date()){
 if(!s.enabled)return 'stopped' as const;
 if(s.last_error_enc)return 'failed' as const;
 if('last_client_seen_at' in s&&(!s.last_client_seen_at||now.getTime()-s.last_client_seen_at.getTime()>45000))return 'waiting' as const;
 if(s.query_from&&s.lease_until&&s.lease_until<=now)return 'failed' as const;
 if(!s.last_success_at)return s.lease_until&&s.lease_until>now?'starting' as const:'waiting' as const;
 if(now.getTime()-s.last_success_at.getTime()>Math.max(120,s.interval_seconds*2+15)*1000)return 'stale' as const;
 return 'healthy' as const;
}
