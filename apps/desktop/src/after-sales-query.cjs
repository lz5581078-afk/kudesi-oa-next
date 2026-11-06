'use strict';
const {allowedJst}=require('./security.cjs');
const {extractVisible,mergeFrames}=require('./extractor.cjs');
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
  if(query.top===0){scroll.scrollTop=0;scroll.dispatchEvent(new Event('scroll'));window.dispatchEvent(new Event('scroll'));return {done:false};}
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
function createReader(contents,ensure,watch){
 let queue=Promise.resolve();
 async function listFrame(kind){
  for(const f of contents.mainFrame.framesInSubtree){if(!allowedJst(f.url)||!await activeFrame(f))continue;try{const state=await runDom(f,'state');if(state.hasList&&(kind==='history'?state.legacy:!state.legacy))return f;}catch{/* transient detached frame */}}
  return null;
 }
 async function openCurrent(){
  if(await listFrame('current'))return true;
  if(!allowedJst(contents.mainFrame.url))return false;
  const result=await runDom(contents.mainFrame,'navigate',{kind:'current'});
  return result.opened;
 }
 async function ready(query){
  await ensure();
  let current=await contents.mainFrame.executeJavaScript(`(${extractVisible.toString()})()`);
  if(!current.sourceCompany)throw new Error('聚水潭尚未登录或登录已失效，请打开连接窗口完成登录');
  if(current.sourceCompany!==query.sourceCompany)throw new Error('聚水潭公司与已确认来源不一致，已停止读取');
  const navigate=()=>runDom(contents.mainFrame,'navigate',query);
  let navigation=await navigate();
  const until=Date.now()+20000;let f,attempts=0;
  while(Date.now()<until){await pause(350);if(!navigation.opened&&attempts++<20)navigation=await navigate();f=await listFrame(query.kind);if(navigation.opened&&f)return f;}
  throw new Error('售后页面未就绪，请在本机连接窗口打开对应售后列表');
 }
 async function settled(f,localPage=false){
  let stable=0;const until=Date.now()+20000;
  while(Date.now()<until){const s=await runDom(f,'state');if(s.error)throw new Error('聚水潭查询失败：'+s.error);const transport=watch?.state();if(transport?.failed)throw new Error('聚水潭查询请求失败，请检查网络、登录及原页面提示');if(!s.loading&&(!watch||(transport&&transport.pending===0&&(transport.started>0||localPage)))){stable++;if(stable>=8)return s;}else stable=0;await pause(150);}
  throw new Error('聚水潭查询未完成，当前结果未作为最新数据提交');
 }
 async function queryPage(input,latest=false){
  const query=validateQuery(input,latest),f=await ready(query);
  const kindState=await runDom(f,'state');
  let filter=f;
  if(kindState.legacy){filter=null;const until=Date.now()+15000;while(Date.now()<until){const candidate=(f.framesInSubtree??contents.mainFrame.framesInSubtree).find(frame=>allowedJst(frame.url)&&/aftersale_filter\.aspx/i.test(new URL(frame.url).pathname));if(candidate){try{if(await activeFrame(candidate)&&(await runDom(candidate,'filterReady',query)).ready){filter=candidate;break;}}catch{/* loading nested frame */}}await pause(200);}}
  if(!filter)throw new Error('历史查询栏未加载，请重新连接');
  watch?.arm();
  const changed=await runDom(filter,'query',latest?{...query,from:undefined,until:undefined}:query);if(changed.error)throw new Error(changed.error);await pause(200);
  await settled(f);
  const beforePage=await f.executeJavaScript(`(${extractVisible.toString()})()`);const previousIds=new Set(mergeFrames([{...beforePage,sourceCompany:query.sourceCompany}]).map(r=>r.afterSaleId));
  let movedPage=false;
  if(query.page!==1){const initial=await runDom(f,'state');const steps=kindState.legacy?Math.max(0,query.page-initial.page):1;for(let i=0;i<steps;i++){watch?.arm();movedPage=true;const p=await runDom(f,'page',query);if(p.error)throw new Error(p.error);await pause(200);await settled(f,true);}}
  const state=await runDom(f,'state');if(state.page!==query.page)throw new Error('页码尚未切换，未提交旧页面数据');
  if(state.pageSize>500)throw new Error('请将聚水潭每页条数调整为500以内后重试');
  const expected=state.total===null?null:Math.max(0,Math.min(state.pageSize,state.total-(state.page-1)*state.pageSize));
  let stalled=0;const rows=new Map();await runDom(f,'scroll',{top:0});await pause(150);
  for(let i=0;i<180;i++){
   const raw=await f.executeJavaScript(`(${extractVisible.toString()})()`);
   for(const r of mergeFrames([{...raw,sourceCompany:query.sourceCompany}]))rows.set(r.afterSaleId,r);
   if(expected!==null&&rows.size>=expected)break;
   const scroll=await runDom(f,'scroll',{top:1});await pause(150);
   if(scroll.done){const tail=await f.executeJavaScript(`(${extractVisible.toString()})()`);for(const r of mergeFrames([{...tail,sourceCompany:query.sourceCompany}]))rows.set(r.afterSaleId,r);if(expected===null||rows.size>=expected||++stalled>8)break;}else stalled=0;
  }
  await runDom(f,'scroll',{top:0});
  if(expected!==null&&rows.size!==expected)throw new Error(`本页应有${expected}条，实际仅读取${rows.size}条；未把部分数据当作整页成功`);
  const records=[...rows.values()];
  if(movedPage&&records.some(r=>previousIds.has(r.afterSaleId)))throw new Error('原页面尚未返回新页数据，未提交重复的上一页');
  if(query.value&&records.some(s=>(query.field==='afterSaleId'?s.afterSaleId:s.internalOrderId)!==query.value))throw new Error('查询条件尚未生效，未返回其他订单的数据');
  const finalState=await runDom(f,'state');if(finalState.error)throw new Error('聚水潭查询失败：'+finalState.error);
  if(state.hasNext===null)throw new Error('无法确认最新结果分页，已停止本轮采集，请检查原页面');
  const result=latest?latestPage(records,query.from,query.until,state.hasNext):{records,hasNext:state.hasNext};
  return {...result,total:state.total,page:state.page,pageSize:state.pageSize,sourceCompany:query.sourceCompany,kind:query.kind};
 }
 return {openCurrent,hasCurrent:async()=>!!await listFrame('current'),query:(q,latest=false)=>{const task=queue.then(()=>queryPage(q,latest)).finally(()=>watch?.stop());queue=task.catch(()=>{});return task;}};
}
module.exports={validateQuery,domQuery,createReader,latestPage,activeFrame};
