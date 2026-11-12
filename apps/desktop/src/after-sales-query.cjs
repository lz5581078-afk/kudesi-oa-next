'use strict';
const {allowedJst}=require('./security.cjs');
const {extractVisible,mergeFrames}=require('./extractor.cjs');
const {readJushuitanRecordingStatus}=require('./jushuitan-recording-status.cjs');
const {expressRecordingResponse}=require('./jushuitan-recording-response.cjs');
const {classicRecordingAction}=require('./jushuitan-recording-player.cjs');
const extractRowsScript=`(${extractVisible.toString()})(null,${readJushuitanRecordingStatus.toString()})`;
const {readAfterSalesPanel}=require('./after-sales-panels.cjs');
const PANEL_ROW_REUSE_MS=15_000;
const REFUND_DISMISS_MS=350;
const panelFields={goods:'售后商品明细',refund:'实退金额明细',logs:'售后日志',tracking:'退货物流明细',shipping:'发货物流明细',platform:'平台售后记录',orderAmount:'原订单下单金额明细',refusal:'拒绝原因明细'};
const isTrackingWaybill=value=>typeof value==='string'&&/^(?=[A-Z0-9-]{6,40}$)[A-Z-]*\d[A-Z0-9-]*$/i.test(value);
const addedFields=['解决方案','供应商售后单状态','供应商退款状态','修改时间','付款时间','退货金额','买家应补运费','拒绝原因',
 '平台卖家退货地址','退货物流状态','售后商品明细','实退金额明细','退货物流明细','发货物流明细','平台售后记录','原订单旗帜','售后标签样式','原订单标签样式','售后问题附件','供分销备注附件','原列表可编辑字段'];
function legacySnapshot(record){
 const fields={...record.fields};
 if(Object.hasOwn(fields,'退货物流状态'))fields['物流状态']=fields['退货物流状态'];
 for(const field of addedFields)delete fields[field];
 return {...record,fields};
}
function validateQuery(v,latest=false){
 if(!v||!['current','history'].includes(v.kind)||!['afterSaleId','internalOrderId'].includes(v.field)||typeof v.value!=='string'||(v.value&&!/^\d{4,80}$/.test(v.value))||typeof v.sourceCompany!=='string'||!v.sourceCompany.trim()||v.sourceCompany.length>100)throw new Error('查询参数无效');
 const page=v.page??1;if(!Number.isSafeInteger(page)||page<1||page>100000)throw new Error('页码无效');
 if(latest&&(v.kind!=='current'||!v.from||!v.until))throw new Error('协同采集只允许最新售后，历史查询由本机操作');
 if((v.from||v.until)&&(!Number.isFinite(Date.parse(v.from))||!Number.isFinite(Date.parse(v.until))||Date.parse(v.from)>Date.parse(v.until)))throw new Error('查询时间无效');
 return {...v,page};
}
function domQuery(command,query){
 const text=e=>String(e?.innerText??e?.value??e?.textContent??'').trim();
 const visible=e=>e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const buttons=()=>[...document.querySelectorAll('button,a,input[type="button"],input[type="submit"],[role="button"]')].filter(visible);
 const exact=(e,s)=>text(e).replace(/\s/g,'')===s.replace(/\s/g,'');
 const input=(field)=>[...document.querySelectorAll('input:not([type="password"]):not([type="hidden"])')].filter(visible).find(e=>[e.placeholder,e.getAttribute('aria-label'),e.title,...[...(e.labels??[])].map(l=>text(l))].some(v=>v&&v.replace(/^请输入/,'').replace(/[:：]/g,'').trim()===field));
 const set=(e,value,enter=false)=>{if(!e)return false;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));if(enter)for(const type of ['keydown','keypress','keyup'])e.dispatchEvent(new KeyboardEvent(type,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));e.dispatchEvent(new FocusEvent('blur',{bubbles:true}));return true;};
 if(command==='navigate'){
  if(query.kind==='classic'){
   const entries=[...document.querySelectorAll('a,[class*="groupItemWrap"]')].filter(visible);
   const entry=entries.find(e=>text(e).replace(/[\s()（）]/g,'')==='售后退货退款');
   if(entry){entry.click();return {opened:true};}
   entries.find(e=>e.localName==='a'&&exact(e,'订单'))?.click();
   return {opened:false};
  }
  const names=query.kind==='history'?['历史售后退货退款','历史售后单']:['售后（极速版）','售后(极速版)'];
  const matches=[...document.querySelectorAll('a,button,span,div,li,p,[role="menuitem"]')].filter(e=>names.some(s=>exact(e,s)));
  const entry=matches.map(e=>e.closest('[class*="groupItemWrap"]')||e.querySelector('[class*="groupItemWrap"]')).find(Boolean)||matches.find(visible);
  if(entry){entry.click();return {opened:true};}
  return {opened:false};
 }
 const headings=[...document.querySelectorAll('thead th,thead td,tr:first-child th,._jt_cell_head')].map(e=>text(e).split('\n')[0].replace(/^\u552e\u540e\u5355\u53f7.*$/,'\u552e\u540e\u5355\u53f7'));
 const hasList=headings.includes('售后单号')&&headings.includes('内部订单号');
 if(command==='state'){
  const body=document.body?.innerText??'';
  const legacy=!!document.querySelector('._jt_cell_head');
  const empty=[...document.querySelectorAll('.ant-empty-normal,.ant-table-placeholder,.ant-alert')]
   .some(e=>visible(e)&&/暂无数据|没有匹配|请在历史售后单查看/.test(text(e)));
  const total=body.match(/共\s*([\d,]+)\s*条/)?.[1]??body.match(/([\d,]+)\s*条记录/)?.[1]??(empty?'0':undefined);
  const current=document.querySelector('.ant-pagination-item-active,.pagination .active');
  const pair=body.match(/(\d+)\s*\/\s*(\d+)\s*页/);
  const size=body.match(/(\d+)\s*条\s*\/\s*页/)?.[1];
  const legacySize=[...document.querySelectorAll('select')].find(e=>[...e.options].some(o=>o.value==='20')&&[...e.options].some(o=>o.value==='50'))?.value;
  const next=document.querySelector('.ant-pagination-next');
  const page=Number(current?.getAttribute('title')??text(current))||Number(pair?.[1])||1,pageSize=Number(size)||Number(legacySize)||50;
  const error=[...document.querySelectorAll('.ant-message-error,.ant-alert-error')].find(e=>visible(e)&&(e.classList.contains('ant-message-error')||/查询失败|加载失败|请求失败|网络错误|网络异常|登录失效|登录过期|未登录|重新登录|无权查询|查询权限不足|获取.+失败|服务器错误|系统异常/i.test(text(e))));
  return {hasList,legacy,error:error?text(error).replace(/https?:\/\/\S+/g,'[链接]').replace(/(?:jmxToken|token|password|cookie|authorization)\s*[:=]\s*[^\s;]+/gi,'[凭据已隐藏]').slice(0,200):null,loading:!![...document.querySelectorAll('.ant-spin-spinning,[aria-busy="true"]')].find(visible),total:total?Number(total.replace(/,/g,'')):null,page,pageSize,hasNext:next?!next.classList.contains('ant-pagination-disabled')&&(next.querySelector('button')?.disabled!==true):total!==undefined?page*pageSize<Number(total.replace(/,/g,'')):null};
 }
 if(command==='classicRecordingSearch'){
  if(!/\/aftersale_filter\.aspx$/i.test(location.pathname))return {queried:false};
  const number=document.querySelector('input#as_id[title="售后单号"]');
  const recording=document.querySelector('select#has_as_ipc');
  const search=[...document.querySelectorAll('span[onclick]')].find(e=>visible(e)&&exact(e,'组合查询'));
  if(!visible(number)||!number.placeholder||!recording||!search||typeof globalThis.CombineFullSearch!=='function')
   return {queried:false};
  set(number,query.value);
  if(!visible(recording))document.getElementById('ipc_search_title')?.closest('.arrow-btn')?.click();
  recording.value='true';
  recording.dispatchEvent(new Event('change',{bubbles:true}));
  search.click();
  return {queried:true};
 }
 if(/aftersale_filter\.aspx/i.test(location.pathname)&&command==='filterReady')return {ready:!!input(query.field==='afterSaleId'?'售后单号':'内部单号')};
 if(/aftersale_filter\.aspx/i.test(location.pathname)&&command==='query'){
  if(!query.value)return {error:'历史售后请填写完整售后单号或内部订单号'};
  set(input(query.field==='afterSaleId'?'内部单号':'售后单号'),'',false);set(input('开始时间'),'',false);set(input('结束时间'),'',false);
  const target=input(query.field==='afterSaleId'?'售后单号':'内部单号');
  return set(target,query.value,true)?{queried:true}:{error:'未找到历史售后的单号查询框，请展开本机原页面核对'};
 }

 if(!hasList)return {error:'当前尚未打开售后列表'};
 if(command==='query'){
  const reset=buttons().find(e=>exact(e,'重置'));if(reset)reset.click();
  const target=input(query.field==='afterSaleId'?'售后单号':'内部订单号');
  if(query.value&&!set(target,query.value))return {error:'未找到原页面的订单号查询框，请展开本机原页面核对'};
  if(!query.value){set(input('售后单号'),'');set(input('内部订单号'),'');}
  if(query.from&&query.until){
   const format=value=>{const d=new Date(Date.parse(value)+8*3600000);return d.toISOString().slice(0,19).replace('T',' ');};
   if(!set(input('开始时间'),format(query.from))||!set(input('结束时间'),format(query.until)))return {error:'原页面申请时间查询框未识别，最新采集已停止，请重新连接检查'};
  }
  const order=[...document.querySelectorAll('a,button')].find(e=>visible(e)&&exact(e,'后申请的在前'));if(order)order.click();
  const search=buttons().find(e=>['搜索','查询'].some(s=>exact(e,s)));if(!search)return {error:'未找到原页面查询按钮'};search.click();return {queried:true};
 }
 if(command==='page'){
  if(document.querySelector('._jt_cell_head')){const next=[...document.querySelectorAll('[title],button,a')].find(e=>visible(e)&&['下一页','下页'].some(k=>e.title===k||text(e)===k));if(next){next.click();return {jumped:true};}return {error:'历史页翻页控件未识别，请在本机原页面翻页读取'};}
  const jump=document.querySelector('.ant-pagination-options-quick-jumper input');
  if(jump&&set(jump,String(query.page),true))return {jumped:true};
  const target=document.querySelector(`.ant-pagination-item[title="${query.page}"]`);if(target){target.click();return {jumped:true};}
  return {error:'原页面页码控件未识别，请在本机原页面定位后重试'};
 }
 if(command==='scroll'){
  const candidates=[...document.querySelectorAll('div,section,tbody,table,main,[role="rowgroup"]')].filter(e=>visible(e)&&e.clientHeight>80&&e.scrollHeight>e.clientHeight+4&&/auto|scroll|hidden/.test(getComputedStyle(e).overflowY));
  const scroll=candidates.sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight)).find(e=>{const before=e.scrollTop;e.scrollTop=before?before-1:1;const changed=e.scrollTop!==before;e.scrollTop=before;return changed;});
  if(!scroll)return {done:true};
  if(query.top===0){
   if(scroll.scrollTop===0)return {done:false,changed:false};
   scroll.scrollTop=0;scroll.dispatchEvent(new Event('scroll'));window.dispatchEvent(new Event('scroll'));
   return {done:false,changed:true};
  }
  const before=scroll.scrollTop;scroll.scrollTop=Math.min(before+Math.max(80,scroll.clientHeight*.65),scroll.scrollHeight-scroll.clientHeight);
  scroll.dispatchEvent(new Event('scroll'));window.dispatchEvent(new Event('scroll'));window.dispatchEvent(new Event('resize'));
  return {done:scroll.scrollTop===before||scroll.scrollTop+scroll.clientHeight>=scroll.scrollHeight-2};
 }
 return {error:'不支持的只读查询操作'};
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function runDom(frame,command,query={}){return frame.executeJavaScript(`(${domQuery.toString()})(${JSON.stringify(command)},${JSON.stringify(query)})`,true);}
async function activeFrame(frame){
 for(let child=frame;child.parent;child=child.parent){
  const name=child.name,path=new URL(child.url).pathname;
  const shown=await child.parent.executeJavaScript(`(()=>{const n=${JSON.stringify(name)},p=${JSON.stringify(path)};const f=[...document.querySelectorAll('iframe,frame')].filter(e=>(n&&e.name===n)||(!n&&(()=>{try{return new URL(e.src,location.href).pathname===p;}catch{return false;}})()));return !f.length||f.some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).display!=='none';});})()`);
  if(!shown)return false;
 }return true;
}

function latestPage(records,start,end,hasNext){
   const dates=records.map(r=>{const m=r.fields['申请时间']?.match(/(\d{4}[-/]\d{2}[-/]\d{2})[\sT]+(\d{2}:\d{2}(?::\d{2})?)/);return m?Date.parse(m[1].replaceAll('/','-')+'T'+(m[2].length===5?m[2]+':00':m[2])+'+08:00'):NaN;});
   if(dates.some((v,i)=>!Number.isFinite(v)||(i>0&&v>dates[i-1])))throw new Error('原页面未按申请时间倒序，最新补采暂停');
   const from=Date.parse(start),until=Date.parse(end);
   const captured=records.filter((_,i)=>dates[i]>=from&&dates[i]<=until);
   if(!records.length||dates.at(-1)<from)hasNext=false;
 return {records:captured,hasNext};
}
function createReader(contents,ensure,watch,observeRecordings){
 let queue=Promise.resolve();
 let latestCursor;
 let panelRow;
 let refundDismissal;
 async function listFrame(kind){
  for(const f of contents.mainFrame.framesInSubtree){
   try{
    if(!allowedJst(f.url)||!await activeFrame(f))continue;
    if(kind==='classic'){
     if(/^\/app\/service\/aftersale\/aftersale\.aspx$/i.test(new URL(f.url).pathname))return f;
     continue;
    }
    const state=await runDom(f,'state');
    if(state.hasList&&(kind==='history'?state.legacy:!state.legacy))return f;
   }catch{/* The ERP can replace a frame while its URL or document is being checked. */}
  }
  return null;
 }
 async function openCurrent(){
  if(await listFrame('current'))return true;
  if(!allowedJst(contents.mainFrame.url))return false;
  const result=await runDom(contents.mainFrame,'navigate',{kind:'current'});
  return result.opened;
 }
 function assertCompany(current,sourceCompany){
  if(current?.state==='unavailable')throw new Error('暂时无法连接聚水潭，请检查网络并打开原页面');
  if(current?.state==='checking')throw new Error('聚水潭正在加载，请稍后再试');
  if(!current?.sourceCompany)throw new Error('聚水潭尚未登录或登录已失效，请打开连接窗口完成登录');
  if(current.sourceCompany!==sourceCompany)throw new Error('聚水潭公司与已确认来源不一致，已停止读取');
 }
 async function ready(query){
  assertCompany(await ensure(),query.sourceCompany);
  const currentList=await listFrame(query.kind);
  if(currentList)return currentList;
  const navigate=()=>runDom(contents.mainFrame,'navigate',query);
  let navigation=await navigate();
  const until=Date.now()+20000;let f,attempts=0;
  while(Date.now()<until){await pause(350);if(!navigation.opened&&attempts++<20)navigation=await navigate();f=await listFrame(query.kind);if(navigation.opened&&f)return f;}
  throw new Error('售后页面未就绪，请在本机连接窗口打开对应售后列表');
 }
 async function settled(f,{localPage=false,shouldContinue,exactSale}){
  let stable=0,lastRequest;
  const until=Date.now()+20000;
  while(Date.now()<until){
   shouldContinue();
   const s=await runDom(f,'state');
   if(s.error)throw new Error('聚水潭查询失败：'+s.error);
   const transport=watch?.state();
   if(lastRequest!==transport?.started){stable=0;lastRequest=transport?.started;}
   // Current pages can settle earlier once the actual list request has finished.
   // Historical pages and client-only page changes use the longer DOM wait.
   const confirmed=transport?.kind==='current'&&transport.completed>0;
   const quiet=!confirmed||Date.now()-transport.finishedAt>=450;
   if(transport?.failed&&!transport.pending&&quiet)throw new Error('聚水潭查询请求失败，请检查网络、登录及原页面提示');
   if(s.hasList&&!s.loading&&(!watch||transport?.pending===0&&(transport.completed>0||localPage))){
    if(exactSale&&confirmed&&!transport.failed&&s.page===1&&s.total===1){
     const started=transport.started;
     const {rows}=await f.executeJavaScript(extractRowsScript);
     const current=watch.state();
     if(rows.length&&rows.every(row=>row.afterSaleId===exactSale)&&
        current?.started===started&&!current.pending&&!current.failed)return started;
    }
    stable++;
    if(stable>=(confirmed?3:8)&&quiet)return transport?.started;
   }else stable=0;
   await pause(confirmed?100:150);
  }
  throw new Error('聚水潭查询未完成，当前结果未作为最新数据提交');
 }
 async function queryPage(input,latest=false,shouldContinue=()=>{},panelLookup=false){
  shouldContinue();
  panelRow=undefined;
  const query=validateQuery(input,latest),f=await ready(query);
  const recordings=observeRecordings&&query.kind==='current'&&new URL(f.url).pathname==='/afterSales'
   ? (command,ids)=>f.executeJavaScript(`(${expressRecordingResponse.toString()})(${JSON.stringify(command)},${JSON.stringify(ids??[])})`).catch(()=>[])
   : null;
  try{
   await recordings?.('start');
   return await readQueryPage(query,f,latest,shouldContinue,panelLookup,recordings);
  }finally{
   await recordings?.('stop');
  }
 }
 async function readQueryPage(query,f,latest,shouldContinue,panelLookup,recordings){
  shouldContinue();
  const kindState=await runDom(f,'state');
  let filter=f;
  if(kindState.legacy){filter=null;const until=Date.now()+15000;while(Date.now()<until){const candidate=(f.framesInSubtree??contents.mainFrame.framesInSubtree).find(frame=>allowedJst(frame.url)&&/aftersale_filter\.aspx/i.test(new URL(frame.url).pathname));if(candidate){try{if(await activeFrame(candidate)&&(await runDom(candidate,'filterReady',query)).ready){filter=candidate;break;}}catch{/* loading nested frame */}}await pause(200);}}
  if(!filter)throw new Error('历史查询栏未加载，请重新连接');
  shouldContinue();
  const key=JSON.stringify([query.sourceCompany,query.from,query.until]);
  const previous=latestCursor;
  latestCursor=undefined;
  const resume=latest&&previous?.key===key&&previous.frame===f&&previous.page+1===query.page&&kindState.page===previous.page;
  let previousIds,requestProof;
  const requestKind=kindState.legacy?'history':'current';
  if(resume){
   previousIds=previous.ids;
  }else{
   let exactSale;
   if(panelLookup&&watch&&!kindState.legacy&&!kindState.loading&&kindState.total!==null){
    // A row that was already the sole result cannot prove a fresh search.
    const previous=kindState.total===1?(await f.executeJavaScript(extractRowsScript)).rows:null;
    if(!previous||previous.length&&previous.every(row=>row.afterSaleId!==query.value))exactSale=query.value;
   }
   watch?.arm(requestKind);
   const changed=await runDom(filter,'query',latest?{...query,from:undefined,until:undefined}:query);
   if(changed.error)throw new Error(changed.error);
   requestProof=await settled(f,{shouldContinue,exactSale});
   if(query.page!==1){
    const beforePage=await f.executeJavaScript(`(${extractVisible.toString()})()`);
    previousIds=new Set(mergeFrames([{...beforePage,sourceCompany:query.sourceCompany}]).map(r=>r.afterSaleId));
   }
  }
  shouldContinue();
  let movedPage=false;
  if(query.page!==1){
   const initial=await runDom(f,'state');
   const steps=kindState.legacy?Math.max(0,query.page-initial.page):1;
   for(let i=0;i<steps;i++){
    shouldContinue();
    watch?.arm(requestKind);
    movedPage=true;
    const result=await runDom(f,'page',query);
    if(result.error)throw new Error(result.error);
    requestProof=await settled(f,{localPage:true,shouldContinue});
   }
  }
  const state=await runDom(f,'state');if(state.page!==query.page)throw new Error('页码尚未切换，未提交旧页面数据');
  if(state.pageSize>500)throw new Error('请将聚水潭每页条数调整为500以内后重试');
  const expected=state.total===null?null:Math.max(0,Math.min(state.pageSize,state.total-(state.page-1)*state.pageSize));
  let stalled=0,atEnd=false;
  const rows=new Map();
  try{
   if((await runDom(f,'scroll',{top:0})).changed)await pause(150);
   for(let i=0;i<180;i++){
    shouldContinue();
    const raw=await f.executeJavaScript(extractRowsScript);
    for(const r of mergeFrames([{...raw,sourceCompany:query.sourceCompany}]))rows.set(r.afterSaleId,r);
    if(expected!==null&&rows.size>=expected)break;
    if(atEnd&&(expected===null||++stalled>8))break;
    atEnd=(await runDom(f,'scroll',{top:1})).done;
    if(!atEnd)stalled=0;
    await pause(150);
   }
  }finally{
   await runDom(f,'scroll',{top:0}).catch(()=>{});
  }
  if(expected!==null&&rows.size!==expected)throw new Error(`本页应有${expected}条，实际仅读取${rows.size}条；未把部分数据当作整页成功`);
  const records=[...rows.values()];
  if(movedPage&&records.some(r=>previousIds.has(r.afterSaleId)))throw new Error('原页面尚未返回新页数据，未提交重复的上一页');
  if(query.value&&records.some(s=>(query.field==='afterSaleId'?s.afterSaleId:s.internalOrderId)!==query.value))throw new Error('查询条件尚未生效，未返回其他订单的数据');
  const unchecked=records.filter(record=>!record.recordingStatus).map(record=>record.afterSaleId);
  if(recordings&&unchecked.length){
   const statuses=new Map(await recordings('read',unchecked));
   for(const record of records)if(!record.recordingStatus&&statuses.has(record.afterSaleId))record.recordingStatus=statuses.get(record.afterSaleId);
  }
  const finalState=await runDom(f,'state');if(finalState.error)throw new Error('聚水潭查询失败：'+finalState.error);
  const transport=watch?.state();
  if(!finalState.hasList||finalState.loading||['page','total','pageSize','hasNext'].some(key=>state[key]!==finalState[key])||
    (transport&&(transport.pending>0||transport.failed||transport.started!==requestProof))){
   throw new Error('读取期间聚水潭列表已更新，本页未提交');
  }
  assertCompany(await ensure(false),query.sourceCompany);
  shouldContinue();
  if(state.hasNext===null)throw new Error('无法确认最新结果分页，已停止本轮采集，请检查原页面');
  observeRecordings?.(records);
  // Playback indicators belong to the desktop session; OA archive payloads are unchanged.
  const archiveRecords=records.map(({recordingStatus,...record})=>record);
  const compatible=query.sourceColumns===true?archiveRecords:archiveRecords.map(legacySnapshot);
  const result=latest?latestPage(compatible,query.from,query.until,state.hasNext):{records:compatible,hasNext:state.hasNext};
  if(latest&&result.hasNext)latestCursor={key,frame:f,page:query.page,ids:new Set(rows.keys())};
  if(!latest&&(query.kind==='current'||panelLookup)&&query.field==='afterSaleId'&&query.value&&records.length===1){
   panelRow={frame:f,record:archiveRecords[0],kind:query.kind,expiresAt:Date.now()+PANEL_ROW_REUSE_MS,requestProof};
  }
  return {...result,total:state.total,page:state.page,pageSize:state.pageSize,sourceCompany:query.sourceCompany,kind:query.kind};
 }
 function enqueue(action){
  const task=queue.then(action).finally(()=>watch?.stop());
  queue=task.catch(()=>{});
  return task;
 }
 async function panel(input){
  if(!input||!Object.hasOwn(panelFields,input.kind)||typeof input.afterSaleId!=='string'||!/^\d{4,40}$/.test(input.afterSaleId))throw new Error('售后明细参数无效');
  const {afterSaleId,sourceCompany,kind,queryProvider,waybill}=input;
  const logistics=kind==='tracking'||kind==='shipping';
  if(queryProvider!==undefined&&(typeof queryProvider!=='boolean'||!logistics)||
     waybill!==undefined&&(!logistics||!isTrackingWaybill(waybill)))
   throw new Error('物流查询参数无效');
  const read=async frame=>{
   const refund=kind==='refund';
   // Leave time for the original hover dismissal before an immediate repeat.
   if(refund&&refundDismissal?.frame===frame){
    const remaining=refundDismissal.until-Date.now();
    if(remaining>0)await pause(remaining);
   }
   const options={queryProvider,waybill};
   const result=await frame.executeJavaScript(`(${readAfterSalesPanel.toString()})(${JSON.stringify(afterSaleId)},${JSON.stringify(kind)},${JSON.stringify(options)})`,true);
   if(refund&&!result.error)refundDismissal={frame,until:Date.now()+REFUND_DISMISS_MS};
   return result;
  };
  let row=panelRow;
  let result;
  if(!input.forceLookup&&row?.record.afterSaleId===afterSaleId&&row.record.sourceCompany===sourceCompany&&
     (row.kind==='current'||logistics)&&row.expiresAt>Date.now()){
   assertCompany(await ensure(false),sourceCompany);
   let stillActive=false;
   try{stillActive=allowedJst(row.frame.url)&&await activeFrame(row.frame);}catch{/* A replaced frame needs a fresh lookup. */}
   if(stillActive)result=await read(row.frame);
  }
  if(!result||result.missingTrigger){
   for(const list of logistics?['current','history']:['current']){
    await queryPage({kind:list,field:'afterSaleId',value:afterSaleId,sourceCompany},false,undefined,true);
    if(!panelRow)continue;
    row=panelRow;
    result=await read(row.frame);
    const transport=watch?.state();
    if(transport&&(transport.started!==row.requestProof||transport.pending||transport.failed)){
     throw new Error('读取明细期间聚水潭列表已更新，请重新查询');
    }
    if(!result.missingTrigger)break;
   }
  }
  if(!result)throw new Error(logistics?'聚水潭当前和历史售后未找到这笔单据':'这笔售后不在聚水潭当前列表');
  if(result.error)throw new Error(result.error);
  assertCompany(await ensure(false),sourceCompany);
  if(result.empty)return null;
  const fields=result.providerUrl?{}:{[panelFields[kind]]:result.content};
  return {...row.record,capturedAt:new Date().toISOString(),fields,
   ...(queryProvider?{provider:'kuaidi100',...(result.providerUrl?{providerUrl:result.providerUrl}:{})}:{})};
 }
 function order(input,readOrder){
  return enqueue(async()=>{
    const {afterSaleId,internalOrderId,sourceCompany}=input;
    const query={kind:'current',field:'afterSaleId',value:afterSaleId,sourceCompany};
    let {records}=await queryPage(query);
    if(!records.some(record=>record.afterSaleId===afterSaleId)){
      query.kind='history';
      ({records}=await queryPage(query));
    }
    if(!records.some(record=>record.afterSaleId===afterSaleId&&record.internalOrderId===internalOrderId)){
      throw new Error('聚水潭查询结果中的售后单号和内部订单号不匹配');
    }
    const frame=await listFrame(query.kind);
    if(!frame)throw new Error('聚水潭售后列表已切换');
    const result=await readOrder(frame);
    assertCompany(await ensure(false),sourceCompany);
    return result;
  });
 }
 function sale(input,openSale,{includeHistory=false}={}){
  return enqueue(async()=>{
    const {afterSaleId,sourceCompany}=input;
    const query={kind:'current',field:'afterSaleId',value:afterSaleId,sourceCompany};
    const matches=records=>records.some(record=>record.afterSaleId===afterSaleId);
    let found=matches((await queryPage(query)).records);
    if(!found&&includeHistory){
      query.kind='history';
      found=matches((await queryPage(query)).records);
    }
    if(!found)throw new Error('聚水潭列表未找到这笔售后');
    const frame=await listFrame(query.kind);
    if(!frame)throw new Error('聚水潭售后列表已切换');
    assertCompany(await ensure(false),sourceCompany);
    return openSale(frame);
  });
 }
 function classicRecording(input){
  return enqueue(async()=>{
   const query=validateQuery({...input,kind:'current',field:'afterSaleId',value:input.afterSaleId});
   const frame=await ready({...query,kind:'classic'});
   panelRow=undefined;
   const deadline=Date.now()+15000;
   let submitted=false;
   while(!submitted&&Date.now()<deadline){
    const filter=(frame.framesInSubtree??contents.mainFrame.framesInSubtree).find(candidate=>
     allowedJst(candidate.url)&&/\/aftersale_filter\.aspx$/i.test(new URL(candidate.url).pathname));
    if(filter)try{submitted=(await runDom(filter,'classicRecordingSearch',query)).queried;}
    catch{/* The original search frame can be replaced while loading. */}
    if(!submitted)await pause(250);
   }
   if(!submitted)return {state:'missing'};
   const run=open=>frame.executeJavaScript(`(${classicRecordingAction.toString()})(${JSON.stringify(query.value)},${open})`,true);
   const resultsDeadline=Date.now()+8500;
   while(Date.now()<resultsDeadline){
    if((await run(false)).state==='found'){
     assertCompany(await ensure(false),query.sourceCompany);
     return run(true);
    }
    await pause(250);
   }
   return {state:'missing'};
  });
 }
 return {openCurrent,hasCurrent:async()=>!!await listFrame('current'),
  query:(q,latest=false,shouldContinue)=>enqueue(()=>queryPage(q,latest,shouldContinue)),
  panel:input=>enqueue(()=>panel(input)),order,sale,classicRecording};
}
module.exports={validateQuery,domQuery,createReader,latestPage,activeFrame,legacySnapshot,isTrackingWaybill};
