import { ApiError, tokenStore } from '../../../../api/client';
import type { SessionWorkspace } from '../../sessionEngine';

const checkedPath=(input:string,workspace?:SessionWorkspace)=>{
  const url=new URL(input,window.location.origin);
  if(url.origin!==window.location.origin||!url.pathname.startsWith('/api/session-manager/'))throw new Error('远程请求目标无效');
  if(workspace)url.searchParams.set('workspaceKey',workspace);
  if(!['finance_withdrawal','company_store_maintenance'].includes(url.searchParams.get('workspaceKey')??''))throw new Error('远程请求缺少工作区');
  return `${url.pathname}${url.search}`;
};
async function request(input:string,options:RequestInit={},workspace?:SessionWorkspace){
  const token=tokenStore.get();
  if(!token)throw new ApiError(401,'请先登录');
  const headers=new Headers(options.headers);
  headers.set('authorization',`Bearer ${token}`);
  if(options.body!==undefined)headers.set('content-type','application/json');
  const response=await fetch(checkedPath(input,workspace),{...options,headers});
  if(tokenStore.get()!==token)throw new Error('登录身份已变化，请重新打开远程协助');
  if(!response.ok){
    let message=`远程请求失败（${response.status}）`;
    try{const body=await response.json() as {message?:string};if(body.message)message=body.message;}catch{/* Keep HTTP status. */}
    throw new ApiError(response.status,message);
  }
  return response;
}
export const fetchJson=async(input:string,options?:RequestInit)=>(await request(input,options)).json();
export const fetchBlob=async(input:string,options?:RequestInit)=>{const response=await request(input,options);return {blob:await response.blob(),headers:response.headers};};
const remoteOptions=(input:string,options:RequestInit={})=>{
  if(new URL(input,window.location.origin).pathname!=='/api/session-manager/open-requests'||options.method?.toUpperCase()!=='POST')return options;
  if(typeof options.body!=='string')throw new Error('远程打开店铺的请求格式无效');
  const body=JSON.parse(options.body) as Record<string,unknown>;
  if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('远程打开店铺的请求格式无效');
  return {...options,body:JSON.stringify({...body,purpose:'remote'})};
};
export function legacyRemoteTransport(workspace:SessionWorkspace){
  return {
    requestJson:async(input:string,options?:RequestInit)=>(await request(input,remoteOptions(input,options),workspace)).json(),
    requestBlob:async(input:string,options?:RequestInit)=>{const response=await request(input,options,workspace);return {blob:await response.blob(),headers:response.headers};},
  };
}
