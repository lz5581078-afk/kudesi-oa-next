'use strict';
/** The current ERP list query observed in the real page. Match origin and path only. */
function isListRequest(kind,url,method,resourceType){
 if(!['xhr','fetch'].includes(resourceType))return false;
 if(kind==='history')return resourceType==='xhr';
 if(method!=='POST')return false;
 try{
  const target=new URL(url);
  return target.origin==='https://innerapi.scm121.com'&&!target.username&&!target.password&&
   target.pathname==='/api/inner/after-sale/page/list';
 }catch{return false;}
}

/** Track request lifecycles. No headers, cookies, parameters or response bodies. */
function createListRequestTracker(){
 let state;
 const requests=new Map();
 return {
  arm(kind='history'){
   requests.clear();
   state={kind,started:0,pending:0,completed:0,failed:0,finishedAt:0,until:Date.now()+1500};
  },
  state:()=>state,
  start(id,url,method,resourceType){
   if(!state||Date.now()>state.until||requests.has(id)||!isListRequest(state.kind,url,method,resourceType))return;
   requests.set(id,++state.started);
   state.pending++;
   return true;
  },
  finish(id,failed){
   const sequence=requests.get(id);
   if(sequence===undefined)return;
   requests.delete(id);
   state.pending--;
   state.completed++;
   state.finishedAt=Date.now();
   if(state.kind==='history')state.failed+=Number(failed);
   else if(sequence===state.started)state.failed=Number(failed);
  },
  stop(){state=undefined;requests.clear();},
 };
}

function createRequestWatch(session){
 const active=new Map(),owners=new Map();
 session.webRequest.onBeforeRequest((details,callback)=>{
  const tracker=active.get(details.webContentsId);
  if(tracker?.start(details.id,details.url,details.method,details.resourceType))owners.set(details.id,tracker);
  callback({});
 });
 const complete=(details,failed)=>{
  const tracker=owners.get(details.id);
  owners.delete(details.id);
  tracker?.finish(details.id,failed);
 };
 session.webRequest.onCompleted(details=>complete(details,details.statusCode>=400));
 session.webRequest.onErrorOccurred(details=>complete(details,true));
 return {forContents(id){
  const tracker=createListRequestTracker();
  const clearOwners=()=>{for(const [request,owner] of owners)if(owner===tracker)owners.delete(request);};
  return {
   arm(kind){clearOwners();tracker.arm(kind);active.set(id,tracker);},
   state:()=>tracker.state()??null,
   stop(){clearOwners();tracker.stop();if(active.get(id)===tracker)active.delete(id);},
  };
 }};
}
module.exports={createRequestWatch,createListRequestTracker};
