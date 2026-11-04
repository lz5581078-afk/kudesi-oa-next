import {useEffect,useState} from 'react';
import {AlertTriangle} from 'lucide-react';
import {createChecker,resourcePermission,SIMILARITY_FIELDS,FEE_SIMILARITY_FIELDS} from '@kudesi/shared';
import {useAuth} from '../auth/AuthContext';
import {resourceApi} from './api';
import {referenceIdentity} from './referenceOptionsCache';
import './archiveSimilarityNotice.css';

/** 原联系/费用新增窗的填写中提示；最终保存仍重新检查，不把预览当保存凭据。 */
export function ArchiveSimilarityNotice({type,values,previewCode}:{type:string;values:Record<string,unknown>;previewCode?:string}){
 const {user}=useAuth();
 const fields=type==='finance-fee-items'?FEE_SIMILARITY_FIELDS:SIMILARITY_FIELDS;
 const body=Object.fromEntries(Object.keys(fields).map(key=>[key,key==='code'?values.code||previewCode||'':values[key]??'']));
 const allowed=!!user&&createChecker(user.permissions)(resourcePermission(type,'view'));
 const scope=JSON.stringify([referenceIdentity(user),type,body,allowed]);
 const [state,setState]=useState<{scope:string;result:Awaited<ReturnType<typeof resourceApi.similarCheck>>}>();
 useEffect(()=>{
  if(!allowed||!String(body.name).trim()||!String(body.code).trim())return;
  let alive=true;
  const timer=setTimeout(()=>{void Promise.resolve().then(()=>resourceApi.similarCheck(type,body)).then(result=>{if(alive)setState({scope,result});}).catch(()=>{});},250);
  return()=>{alive=false;clearTimeout(timer);};
 },[scope]); // eslint-disable-line react-hooks/exhaustive-deps
 const result=state?.scope===scope?state.result:undefined;
 const matches=result?[...result.blocked,...result.warnings].slice(0,3):[];
 if(!matches.length)return null;
 const blocked=!!result?.blocked.length;
 return <div className={`reference-archive-similarity${blocked?' is-blocked':''}`} role="alert"><AlertTriangle size={18}/><div><strong>{blocked?'发现完全相同的资料，禁止保存':'发现可能相似的资料'}</strong>{matches.map((match,index)=><p key={index}>{match.text}</p>)}{!blocked&&<small>请核对后再保存；相似资料可以确认后继续。</small>}</div></div>;
}
