import {useEffect,useRef,useState} from 'react';
import {
 AFTER_SALES_COLUMNS_PREFERENCE,normalizeAfterSalesColumns,normalizeAfterSalesColumnWidths,
 type AfterSalesColumn,type AfterSalesColumnPreference,type AfterSalesColumnWidths,type AfterSalesWidthColumn,
} from '@kudesi/shared';
import {useAuth} from '../../auth/AuthContext';
import {api,tokenStore} from '../../api/client';

type Cached=AfterSalesColumnPreference&{pending?:boolean};
const path='/user-preferences/'+AFTER_SALES_COLUMNS_PREFERENCE;
const defaults:AfterSalesColumnPreference={columns:normalizeAfterSalesColumns(null),widths:{}};

function readCache(key:string):{value:AfterSalesColumnPreference;pending:boolean}|null{
 try{
  const value=JSON.parse(localStorage.getItem(key)??'null');
  return Array.isArray(value?.columns)
   ? {value:{columns:normalizeAfterSalesColumns(value.columns),widths:normalizeAfterSalesColumnWidths(value.widths)},pending:!!value.pending}
   : null;
 }catch{return null;}
}
function writeCache(key:string,value:Cached){
 try{localStorage.setItem(key,JSON.stringify(value));}catch{/* Optional local cache. */}
}

export function useAfterSalesColumns(){
 const {user}=useAuth();
 const key=user?`oa.afterSales.columns.${user.companyId}.${user.id}`:'';
 const [state,setState]=useState<{key:string;value:AfterSalesColumnPreference;failed?:boolean}|null>(null);
 const revision=useRef(0), queue=useRef(Promise.resolve());
 const value=state?.key===key?state.value:(key&&readCache(key)?.value)||defaults;

 function save(scope:string,identity:string|null,values:AfterSalesColumnPreference){
  const request=++revision.current;
  setState({key:scope,value:values});
  if(!scope||!identity)return;
  writeCache(scope,{...values,pending:true});
  queue.current=queue.current.then(async()=>{
   if(tokenStore.get()!==identity)return;
   try{
    await api(path,{method:'PUT',body:{value:values}});
    if(revision.current===request&&tokenStore.get()===identity)writeCache(scope,values);
   }catch{
    if(revision.current===request&&tokenStore.get()===identity)setState({key:scope,value:values,failed:true});
   }
  });
 }

 useEffect(()=>{
  if(!key)return;
  const initial=++revision.current,identity=tokenStore.get(),cached=readCache(key);
  if(cached?.pending){save(key,identity,cached.value);return;}
  let active=true;
  void api<{value:AfterSalesColumnPreference|null}>(path).then(result=>{
   if(!active||revision.current!==initial||tokenStore.get()!==identity||!Array.isArray(result.value?.columns))return;
   const values={columns:normalizeAfterSalesColumns(result.value.columns),widths:normalizeAfterSalesColumnWidths(result.value.widths)};
   setState({key,value:values});
   writeCache(key,values);
  }).catch(()=>{});
  return()=>{active=false;};
 },[key]);

 const commit=(next:AfterSalesColumnPreference)=>save(key,tokenStore.get(),next);
 return {
  ...value,
  failed:state?.key===key&&!!state.failed,
  changeColumns:(columns:AfterSalesColumn[])=>commit({...value,columns:normalizeAfterSalesColumns(columns)}),
  changeWidth:(column:AfterSalesWidthColumn,width?:number)=>{
   const widths:AfterSalesColumnWidths={...value.widths};
   if(width===undefined)delete widths[column];
   else widths[column]=width;
   commit({...value,widths});
  },
  resetWidths:()=>commit({...value,widths:{}}),
  retry:()=>commit(value),
 };
}
