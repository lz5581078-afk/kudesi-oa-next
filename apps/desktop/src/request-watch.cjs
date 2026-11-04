'use strict';
/** Observe request lifecycle only. Never inspect URL, request args, headers, cookies or response bodies. */
function createRequestWatch(session){
 const active=new Map(),owners=new Map();
 session.webRequest.onBeforeRequest((details,callback)=>{
  const state=active.get(details.webContentsId);
  if(details.resourceType==='xhr'&&state&&Date.now()<=state.until&&!owners.has(details.id)){
   state.started++;state.pending++;owners.set(details.id,state);
  }
  callback({});
 });
 const complete=(details,failed)=>{const state=owners.get(details.id);if(!state)return;owners.delete(details.id);state.pending--;state.completed++;if(failed)state.failed++;};
 session.webRequest.onCompleted(details=>complete(details,details.statusCode>=400));
 session.webRequest.onErrorOccurred(details=>complete(details,true));
 return {forContents(id){return {
  arm(){active.set(id,{started:0,pending:0,completed:0,failed:0,until:Date.now()+1500});},
  state(){const value=active.get(id);return value?{started:value.started,pending:value.pending,completed:value.completed,failed:value.failed}:null;},
  stop(){active.delete(id);},
 };}};
}
module.exports={createRequestWatch};
