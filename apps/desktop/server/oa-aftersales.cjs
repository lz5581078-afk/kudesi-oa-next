'use strict';

const {randomUUID}=require('node:crypto');
const {createReader}=require('../src/after-sales-query.cjs');
const {allowedJst}=require('../src/security.cjs');
const {inspectJushuitanSession}=require('../src/jushuitan-session.cjs');
const {createListRequestTracker}=require('../src/request-watch.cjs');

const minute=60_000;
const collectionPath='/desktop-after-sales-collection';
const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const parseTime=value=>{
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw new Error('编码预留时间须使用 HH:mm');
  const [hour,minutes]=value.split(':').map(Number);
  return hour*60+minutes;
};
function reservedWindow(start,end){
  const from=parseTime(start),until=parseTime(end);
  if(from===until)throw new Error('编码预留窗口的开始与结束时间不能相同');
  return date=>{
    const now=parseTime(clock.format(date));
    return from<until ? now>=from&&now<until : now>=from||now<until;
  };
}

function settings(env){
  const {OA_AFTER_SALES_URL,OA_AFTER_SALES_ACCOUNT,OA_AFTER_SALES_PASSWORD,OA_AFTER_SALES_SOURCE,
    OA_AFTER_SALES_OA_COMPANY_ID,OA_AFTER_SALES_AI_COMPANY_ID}=env;
  const url=new URL(OA_AFTER_SALES_URL);
  const loopback=url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname);
  if((!loopback&&url.protocol!=='https:')||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
    throw new Error('OA 售后服务地址无效');
  if(![OA_AFTER_SALES_OA_COMPANY_ID,OA_AFTER_SALES_AI_COMPANY_ID].every(id=>/^[1-9]\d*$/.test(id||''))||
    !OA_AFTER_SALES_ACCOUNT||!OA_AFTER_SALES_PASSWORD||!OA_AFTER_SALES_SOURCE?.trim())
    throw new Error('请配置 OA 采集账号、两边的公司 ID 和聚水潭来源');
  return {origin:url.origin,account:OA_AFTER_SALES_ACCOUNT,password:OA_AFTER_SALES_PASSWORD,
    source:OA_AFTER_SALES_SOURCE.trim(),oaCompanyId:OA_AFTER_SALES_OA_COMPANY_ID,aiCompanyId:OA_AFTER_SALES_AI_COMPANY_ID,
    reserved:reservedWindow(env.OA_AFTER_SALES_RESERVE_START||'02:00',env.OA_AFTER_SALES_RESERVE_END||'07:30')};
}

function oaClient(config){
  let token;
  async function send(path,body){
    return fetch(config.origin+'/api'+path,{method:body===undefined?'GET':'POST',redirect:'error',
      headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
  }
  async function login(){
    const response=await send('/auth/login',{account:config.account,password:config.password});
    if(!response.ok)throw new Error('OA 采集账号登录失败');
    const result=await response.json();
    if(result.type!=='company'||String(result.user?.companyId)!==config.oaCompanyId||result.user.feishuBindingPending||result.user.mustChangePassword||!result.accessToken)
      throw new Error('OA 采集账号公司或登录授权不匹配');
    token=result.accessToken;
  }
  return async(path,body)=>{
    if(!token)await login();
    let response=await send(path,body);
    if(response.status===401){token=undefined;await login();response=await send(path,body);}
    if(!response.ok)throw new Error('OA 售后采集接口返回 '+response.status);
    const json=await response.text();
    return json?JSON.parse(json):null;
  };
}

function readerFor(page){
  const wrappers=new WeakMap();
  function wrap(frame){
    if(!frame)return null;
    if(!wrappers.has(frame))wrappers.set(frame,{
      get url(){return frame.url();},get name(){return frame.name();},get parent(){return wrap(frame.parentFrame());},
      get framesInSubtree(){return [this,...frame.childFrames().flatMap(child=>wrap(child).framesInSubtree)];},
      executeJavaScript(script){
        if(!allowedJst(frame.url(),{subframe:!!frame.parentFrame()}))throw new Error('聚水潭页面已离开授权域名');
        return frame.evaluate(script);
      },
    });
    return wrappers.get(frame);
  }
  const watch=createListRequestTracker();
  page.on('request',request=>{
    watch.start(request,request.url(),request.method(),request.resourceType());
  });
  page.on('response',response=>{if(response.status()>=400)watch.finish(response.request(),true);});
  page.on('requestfinished',request=>watch.finish(request,false));
  page.on('requestfailed',request=>watch.finish(request,true));
  const contents={get mainFrame(){return wrap(page.mainFrame());}};
  const inspect=async()=>{
    if(!allowedJst(page.url()))return {state:'unavailable'};
    return contents.mainFrame.executeJavaScript('('+inspectJushuitanSession.toString()+')()');
  };
  return {inspect,reader:createReader(contents,inspect,watch)};
}

function start({configureCollectorSchedule,runWhenCollectorIdle,getSession,env=process.env,log=console}){
  const config=settings(env),api=oaClient(config),clientId=randomUUID();
  const stopSchedule=configureCollectorSchedule?.(config.aiCompanyId,config.reserved);
  let stopped=false,timer,page,adapter,nextQueryAt;
  async function closePage(){
    const closing=page;
    page=undefined;
    adapter=undefined;
    await closing?.close().catch(()=>{});
  }
  const reserved=()=>config.reserved(new Date());
  async function round(companyBusy){
    let cutoff=Infinity;
    const mustYield=()=>stopped||reserved()||companyBusy();
    const ensureIdle=()=>{
      if(mustYield())throw new Error('已让出聚水潭会话');
      if(Date.now()>=cutoff)throw new Error('本轮售后查询超时');
    };
    const sources=await api(collectionPath);
    const source=sources.find(row=>row.sourceCompany===config.source);
    if(!source?.enabled||source.intervalSeconds!==60||mustYield())return;
    const base=collectionPath+'/'+source.id;
    const lease=await api(base+'/claim',{clientId});
    if(!lease)return;
    const body={token:lease.token};
    cutoff=Date.now()+75_000;
    const deadline=setInterval(()=>{
      if(mustYield()||Date.now()>=cutoff)void closePage();
    },500);
    try{
      ensureIdle();
      if(!page||page.isClosed()){
        const {context}=await getSession(config.aiCompanyId);
        ensureIdle();
        page=await context.newPage();
        ensureIdle();
        adapter=readerFor(page);
        await page.goto('https://www.erp321.com/epaas',{waitUntil:'domcontentloaded',timeout:15_000});
        for(let i=0;i<32&&(await adapter.inspect()).state==='checking';i++){
          ensureIdle();
          await new Promise(resolve=>setTimeout(resolve,250));
        }
      }
      if(lease.sourceCompany!==config.source)throw new Error('采集来源已变更');
      for(let index=lease.page;;index++){
        ensureIdle();
        await api(base+'/heartbeat',body);
        const result=await adapter.reader.query({kind:'current',field:'afterSaleId',value:'',sourceCompany:config.source,
          from:lease.from,until:lease.until,page:index,sourceColumns:true},true,ensureIdle);
        ensureIdle();
        const completed=lease.firstPageOnly||!result.hasNext;
        const commit=await api(base+'/commit',{...body,page:index,records:result.records,completed});
        if(completed||commit?.completed){
          nextQueryAt=Date.parse(commit?.nextQueryAt);
          break;
        }
      }
    }catch(error){
      if(mustYield())await api(base+'/yield',body).catch(()=>{});
      else {
        const message=/^聚水潭(?:尚未登录|公司与已确认来源不一致)/.test(error?.message||'')?
          error.message:'服务器售后查询未完成，请检查聚水潭会话及售后页面';
        await api(base+'/fail',{...body,message}).catch(()=>{});
      }
      await closePage();
    }finally{clearInterval(deadline);}
  }
  async function tick(){
    nextQueryAt=undefined;
    try{
      if(reserved())await closePage();
      else await runWhenCollectorIdle(config.aiCompanyId,round);
    }catch{log.warn('[oa-aftersales] 本轮未运行，请检查 OA 采集配置及连接');}
    finally{
      if(!stopped)timer=setTimeout(tick,reserved()?minute-Date.now()%minute:
        Number.isFinite(nextQueryAt)?Math.max(250,nextQueryAt-Date.now()+250):minute);
    }
  }
  void tick();
  return async()=>{stopped=true;clearTimeout(timer);stopSchedule?.();await closePage();};
}

module.exports={start,reservedWindow,readerFor};
