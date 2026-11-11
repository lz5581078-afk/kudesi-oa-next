const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {JSDOM}=require('jsdom');
const {start,reservedWindow}=require('../server/oa-aftersales.cjs');

test('编码独占窗口以北京时间判断，并支持跨午夜',()=>{
  const morning=reservedWindow('02:00','07:30');
  assert.equal(morning(new Date('2026-11-06T17:59:59Z')),false);
  assert.equal(morning(new Date('2026-11-06T18:00:00Z')),true);
  assert.equal(morning(new Date('2026-11-06T23:29:59Z')),true);
  assert.equal(morning(new Date('2026-11-06T23:30:00Z')),false);
  const reserved=reservedWindow('23:45','06:00');
  assert.equal(reserved(new Date('2026-11-07T15:44:59Z')),false);
  assert.equal(reserved(new Date('2026-11-07T15:45:00Z')),true);
  assert.equal(reserved(new Date('2026-11-07T21:59:59Z')),true);
  assert.equal(reserved(new Date('2026-11-07T22:00:00Z')),false);
  assert.throws(()=>reservedWindow('06:00','06:00'));
});

test('复用采集会话并按 OA 租约回补，只提交时间范围内的售后',async t=>{
  const env={OA_AFTER_SALES_URL:'http://127.0.0.1:4002',OA_AFTER_SALES_ACCOUNT:'fixture',OA_AFTER_SALES_PASSWORD:'fixture',
    OA_AFTER_SALES_SOURCE:'演示公司',OA_AFTER_SALES_OA_COMPANY_ID:'7',OA_AFTER_SALES_AI_COMPANY_ID:'9'};
  // Reserve a short window far from the current local hour, so this test can run at any time.
  const shanghaiHour=(new Date().getUTCHours()+8)%24;
  const time=offset=>String((shanghaiHour+offset)%24).padStart(2,'0')+':00';
  env.OA_AFTER_SALES_RESERVE_START=time(12);
  env.OA_AFTER_SALES_RESERVE_END=time(13);
  const from='2026-11-04T02:10:00.000Z',until='2026-11-07T02:10:00.000Z';
  const salePath='/api/desktop-after-sales-collection';
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const path=new URL(url).pathname,body=options.body&&JSON.parse(options.body);
    calls.push({path,body});
    if(path==='/api/auth/login')return Response.json({type:'company',user:{companyId:7},accessToken:'fixture'});
    assert.equal(options.headers.Authorization,'Bearer fixture');
    if(path===salePath)return Response.json([{id:18,sourceCompany:'演示公司',enabled:true,intervalSeconds:60}]);
    if(path===salePath+'/18/claim')return Response.json({token:'fixture-lease',sourceCompany:'演示公司',page:1,from,until});
    return Response.json({completed:true});
  });

  const {window}=new JSDOM(`<div>演示公司 [客服]</div>
    <nav role="menu">工作台</nav><button>搜索</button>
    <table><thead><tr><th>售后单号</th><th>内部订单号</th><th>申请时间</th></tr></thead><tbody>
    <tr><td>85110001</td><td>44110001</td><td>2026-11-07 10:00:00</td></tr>
    <tr><td>85110002</td><td>44110002</td><td>2026-11-04 10:10:00</td></tr>
    <tr><td>85110003</td><td>44110003</td><td>2026-11-04 10:09:59</td></tr></tbody></table><div>共3条 50 条/页</div>`,
  {url:'https://www.erp321.com/epaas',runScripts:'outside-only'});
  Object.defineProperty(window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  window.HTMLElement.prototype.getClientRects=()=>[{}];
  const frame={url:()=>window.location.href,name:()=>'',parentFrame:()=>null,childFrames:()=>[],evaluate:async script=>window.eval(script)};
  const page=Object.assign(new EventEmitter(),{url:frame.url,mainFrame:()=>frame,goto:async()=>{},close:async()=>{},isClosed:()=>false});
  window.document.querySelector('button').addEventListener('click',()=>{
    const request={url:()=>'https://innerapi.scm121.com/api/inner/after-sale/page/list',method:()=>'POST',resourceType:()=>'fetch'};
    page.emit('request',request);
    page.emit('requestfinished',request);
  });

  let done;
  const ran=new Promise(resolve=>{done=resolve;});
  const stop=start({env,runWhenCollectorIdle:async(company,run)=>{
    assert.equal(company,'9');
    try{await run(()=>false);}finally{done();}
  },getSession:async company=>{
    assert.equal(company,'9');
    return {context:{newPage:async()=>page}};
  }});
  try{
    await ran;
    assert.deepEqual(calls.map(({path})=>path),['/api/auth/login',salePath,salePath+'/18/claim',salePath+'/18/heartbeat',salePath+'/18/commit']);
    assert.equal(calls.at(-1).body.completed,true);
    assert.deepEqual(calls.at(-1).body.records.map(row=>row.afterSaleId),['85110001','85110002']);
  }finally{await stop();window.close();}
});
