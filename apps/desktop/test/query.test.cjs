const {test}=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {validateQuery,domQuery}=require('../src/after-sales-query.cjs');
const base={kind:'current',field:'afterSaleId',value:'',sourceCompany:'演示公司'};
test('latest collection rejects historical tasks, arbitrary inputs and unbounded queries',()=>{
 assert.throws(()=>validateQuery({...base,kind:'history'},true),/只允许最新/);
 assert.throws(()=>validateQuery(base,true),/只允许最新/);
 assert.throws(()=>validateQuery({...base,value:'<script>'}));assert.throws(()=>validateQuery({...base,page:-1}));
 assert.equal(validateQuery({...base,from:'2026-11-04T00:00:00Z',until:'2026-11-04T01:00:00Z'},true).page,1);
 assert.equal(validateQuery({...base,kind:'history',value:'85110001'}).kind,'history');
});
function dom(html){const d=new JSDOM(html,{runScripts:'outside-only'});Object.defineProperty(d.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});d.window.HTMLElement.prototype.getClientRects=()=>[{}];return d;}
test('a disposed ERP frame does not hide the current after-sales list',async()=>{
 const {createReader}=require('../src/after-sales-query.cjs');
 const gone={get url(){throw new Error('Render frame was disposed');}};
 const current={url:'https://www.erp321.com/epaas',executeJavaScript:async()=>({hasList:true,legacy:false})};
 current.framesInSubtree=[gone,current];
 assert.equal(await createReader({mainFrame:current}).hasCurrent(),true);
});
test('query only clicks safe search controls and never financial operation buttons',()=>{
 const d=dom('<table><thead><tr><th>售后单号</th><th>内部订单号</th></tr></thead></table><input placeholder="请输入售后单号"><button id="search">搜索</button><button id="refund">同意退款</button><button id="receipt">确认收货</button>');
 let searched=0,financial=0;d.window.document.querySelector('#search').onclick=()=>searched++;for(const id of ['refund','receipt'])d.window.document.getElementById(id).onclick=()=>financial++;
 const r=d.window.eval(`(${domQuery.toString()})('query',${JSON.stringify({...base,value:'85110001'})})`);
 assert.equal(r.queried,true);assert.equal(searched,1);assert.equal(financial,0);assert.equal(d.window.document.querySelector('input').value,'85110001');
});
test('unrecognized date filtering fails explicitly rather than falsely reporting latest success',()=>{
 const d=dom('<table><thead><tr><th>售后单号</th><th>内部订单号</th></tr></thead></table><button>搜索</button>');
 const r=d.window.eval(`(${domQuery.toString()})('query',${JSON.stringify({...base,from:'2026-11-04T00:00:00Z',until:'2026-11-04T01:00:00Z'})})`);assert.match(r.error,/采集已停止/);
});
test('virtualized table scroll is required to collect all rows, not just the initial three',async()=>{
 const {createReader}=require('../src/after-sales-query.cjs');
 const d=dom('<p>演示公司 [客服]</p><button>售后（极速版）</button><input placeholder="开始时间"><input placeholder="结束时间"><button>搜索</button><div id="scroll" style="overflow-y:auto"><table><thead><tr><th>售后单号</th><th>内部订单号</th><th>申请时间</th></tr></thead><tbody></tbody></table></div><div>共50条 50 条/页</div><div class="ant-pagination-item-active" title="1">1</div><li class="ant-pagination-next ant-pagination-disabled"><button disabled></button></li>');
 const pane=d.window.document.getElementById('scroll'),body=d.window.document.querySelector('tbody');
 Object.defineProperty(pane,'clientHeight',{value:240});Object.defineProperty(pane,'scrollHeight',{value:4000});let top=0;
 const render=()=>{const first=Math.min(47,Math.floor(top/80));body.innerHTML=Array.from({length:3},(_,j)=>`<tr><td>${85110000+first+j}</td><td>${4400000+first+j}</td><td>2026-11-04 08:00:00</td></tr>`).join('');};
 Object.defineProperty(pane,'scrollTop',{get:()=>top,set:v=>{top=v;render();}});render();
 const frame={url:'https://erp321.com/epaas',parent:null,executeJavaScript:script=>Promise.resolve(d.window.eval(script))};frame.framesInSubtree=[frame];
 const contents={mainFrame:frame,debugger:{isAttached:()=>true,sendCommand:async()=>undefined}};
 const result=await createReader(contents,async()=>({state:'authenticated',sourceCompany:base.sourceCompany})).query({...base,from:'2026-11-04T00:00:00Z',until:'2026-11-04T01:00:00Z'},true);
 assert.equal(result.records.length,50);assert.equal(new Set(result.records.map(v=>v.afterSaleId)).size,50);assert.equal(result.hasNext,false);
});
test('latest range stops at its time boundary, excludes future/old cases and refuses missing or unsorted application times',()=>{
 const {latestPage}=require('../src/after-sales-query.cjs');const row=at=>({fields:{申请时间:at}});
 const values=[row('2026-11-04 10:00:00'),row('2026-11-04 09:30:00'),row('2026-11-04 08:00:00')];
 const result=latestPage(values,'2026-11-04T01:00:00Z','2026-11-04T01:45:00Z',true);assert.equal(result.records.length,1);assert.equal(result.records[0].fields['申请时间'],'2026-11-04 09:30:00');assert.equal(result.hasNext,false);
 assert.throws(()=>latestPage([values[1],values[0]],'2026-11-04T00:00:00Z','2026-11-04T02:00:00Z',true),/暂停/);
 assert.throws(()=>latestPage([{fields:{}}],'2026-11-04T00:00:00Z','2026-11-04T02:00:00Z',true),/暂停/);
});
test('late list refresh during extraction does not publish the page',async()=>{
 const {createReader}=require('../src/after-sales-query.cjs');
 const {createListRequestTracker}=require('../src/request-watch.cjs');
 const watch=createListRequestTracker();
 const url='https://innerapi.scm121.com/api/inner/after-sale/page/list';
 const d=dom('<button>搜索</button><table><thead><tr><th>售后单号</th><th>内部订单号</th></tr></thead><tbody><tr><td>85110001</td><td>44110001</td></tr></tbody></table><div>共1条 50 条/页</div>');
 d.window.document.querySelector('button').onclick=()=>{watch.start(1,url,'POST','fetch');watch.finish(1,false);};
 const frame={url:'https://erp321.com/epaas',parent:null,executeJavaScript:async script=>{
  const result=d.window.eval(script);
  if(script.includes('function extractVisible'))watch.start(2,url,'POST','fetch');
  return result;
 }};
 frame.framesInSubtree=[frame];
 let published=false;
 const reader=createReader({mainFrame:frame},async()=>({state:'authenticated',sourceCompany:base.sourceCompany}),watch,()=>{published=true;});
 try{
  await assert.rejects(reader.query(base),/读取期间聚水潭列表已更新/);
  assert.equal(published,false);
 }finally{d.window.close();}
});
test('same sale panels reuse the verified row until a fresh lookup is requested',async()=>{
 const {createReader}=require('../src/after-sales-query.cjs');
 const {createListRequestTracker}=require('../src/request-watch.cjs');
 const watch=createListRequestTracker();
 const url='https://innerapi.scm121.com/api/inner/after-sale/page/list';
 const d=dom('<input placeholder="售后单号"><button>搜索</button><table><thead><tr><th>售后单号</th><th>内部订单号</th></tr></thead><tbody><tr><td>85110001</td><td>44110001</td></tr></tbody></table><div>共1条 50 条/页</div>');
 let searches=0;
 d.window.document.querySelector('button').onclick=()=>{
  watch.start(++searches,url,'POST','fetch');
  watch.finish(searches,false);
 };
 const frame={url:'https://erp321.com/epaas',parent:null,executeJavaScript:async script=>
  script.includes('function readAfterSalesPanel')?{content:'source detail'}:d.window.eval(script)};
 frame.framesInSubtree=[frame];
 const reader=createReader({mainFrame:frame},async()=>({state:'authenticated',sourceCompany:base.sourceCompany}),watch);
 const input={afterSaleId:'85110001',sourceCompany:base.sourceCompany};
 try{
  assert.equal((await reader.panel({...input,kind:'logs'})).fields['售后日志'],'source detail');
  assert.equal((await reader.panel({...input,kind:'goods'})).afterSaleId,input.afterSaleId);
  assert.equal(searches,1);
  await reader.panel({...input,kind:'refund',forceLookup:true});
  assert.equal(searches,2);
 }finally{d.window.close();}
});
test('first panel read waits for the exact row after a reset and rejects a refresh during the popup read',async()=>{
 const {createReader}=require('../src/after-sales-query.cjs');
 const {createListRequestTracker}=require('../src/request-watch.cjs');
 const watch=createListRequestTracker();
 const url='https://innerapi.scm121.com/api/inner/after-sale/page/list';
 const d=dom('<input placeholder="售后单号"><button>搜索</button><table><thead><tr><th>售后单号</th><th>内部订单号</th></tr></thead><tbody><tr><td>85110002</td><td>44110002</td></tr></tbody></table><div>共1条 50 条/页</div>');
 const cell=d.window.document.querySelector('tbody td');
 let submitted=false,refreshDuringRead=false;
 d.window.document.querySelector('button').onclick=()=>{
  submitted=false;
  watch.start(1,url,'POST','fetch');
  watch.finish(1,false);
  d.window.setTimeout(()=>{
   watch.start(2,url,'POST','fetch');
   cell.textContent='85110001';
   submitted=true;
   watch.finish(2,false);
  },130);
 };
 const frame={url:'https://erp321.com/epaas',parent:null,executeJavaScript:async script=>{
  if(!script.includes('function readAfterSalesPanel'))return d.window.eval(script);
  assert.equal(submitted,true);
  assert.equal(cell.textContent,'85110001');
  if(refreshDuringRead)watch.start(3,url,'POST','fetch');
  return {content:'source detail'};
 }};
 frame.framesInSubtree=[frame];
 const reader=createReader({mainFrame:frame},async()=>({state:'authenticated',sourceCompany:base.sourceCompany}),watch);
 const input={afterSaleId:'85110001',sourceCompany:base.sourceCompany,kind:'logs',forceLookup:true};
 try{
  assert.equal((await reader.panel(input)).fields['售后日志'],'source detail');
  cell.textContent='85110002';
  refreshDuringRead=true;
  await assert.rejects(reader.panel(input),/读取明细期间聚水潭列表已更新/);
 }finally{d.window.close();}
});
test('one desktop continues the same collection range without re-running its first-page search',async()=>{
 const {createReader}=require('../src/after-sales-query.cjs');
 const d=dom(`<button id="search">搜索</button>
   <table><thead><tr><th>售后单号</th><th>内部订单号</th><th>申请时间</th><th>操作</th></tr></thead><tbody></tbody></table>
   <div>共2条 1 条/页</div><div class="ant-pagination-item-active" title="1"></div>
   <button class="ant-pagination-item" title="2">2</button><div class="ant-pagination-next"></div>`);
 const doc=d.window.document,tbody=doc.querySelector('tbody'),active=doc.querySelector('.ant-pagination-item-active');
 const next=doc.querySelector('.ant-pagination-next');
 const render=page=>{
   active.title=String(page);
   next.classList.toggle('ant-pagination-disabled',page===2);
   tbody.innerHTML=`<tr><td>${85110000+page}</td><td>${4400000+page}</td><td>2026-11-04 08:00:00</td><td>${page===1?'有录像':'无录像'}</td></tr>`;
 };
 let searches=0;
 doc.querySelector('#search').onclick=()=>{searches++;render(1);};
 doc.querySelector('button[title="2"]').onclick=()=>render(2);
 render(1);
 const frame={url:'https://erp321.com/epaas',parent:null,executeJavaScript:script=>Promise.resolve(d.window.eval(script))};
 frame.framesInSubtree=[frame];
 const observed=[];
 const reader=createReader({mainFrame:frame},async()=>({state:'authenticated',sourceCompany:base.sourceCompany}),undefined,rows=>observed.push(...rows));
 const query={...base,sourceColumns:true,from:'2026-11-04T00:00:00Z',until:'2026-11-04T01:00:00Z'};
 await assert.rejects(reader.query(query,true,()=>{throw new Error('前台正在查询');}),/前台正在查询/);
 assert.equal(searches,0);
 const first=await reader.query(query,true);
 const second=await reader.query({...query,page:2},true);
 assert.equal(first.records[0].afterSaleId,'85110001');
 assert.equal(second.records[0].afterSaleId,'85110002');
 assert.deepEqual(observed.map(row=>row.recordingStatus),['available','unavailable']);
 assert.equal(Object.hasOwn(first.records[0],'recordingStatus'),false);
 assert.equal(second.hasNext,false);
 assert.equal(searches,1);
 d.window.close();
});
test('an archive notice is not a query failure; actual error toasts are failures and credentials are scrubbed',()=>{
 const d=dom('<div class="ant-alert-error">订单已归档至2025-10-10，请在历史售后单查看</div>');
 assert.equal(d.window.eval(`(${domQuery.toString()})('state',{})`).error,null);
 const error=d.window.document.createElement('div');error.className='ant-message-error';error.textContent='请求失败 token=never-log https://erp321.com/?token=never-log';d.window.document.body.append(error);
 const result=d.window.eval(`(${domQuery.toString()})('state',{})`);assert.match(result.error,/请求失败/);assert.equal(result.error.includes('never-log'),false);
});

test('极速版仅将完整成功批次内缺席的售后单标为没视频',async()=>{
 const {createReader}=require('../src/after-sales-query.cjs');
 const d=dom(`<button id="search">搜索</button>
  <table><thead><tr><th>售后单号</th><th>内部订单号</th></tr></thead><tbody>
   <tr><td>85110001</td><td>4400001</td></tr>
   <tr><td>85110002</td><td>4400002</td></tr>
   <tr><td>85110003</td><td>4400003</td></tr>
   <tr><td>85110004</td><td>4400004</td></tr>
   <tr><td>85110005</td><td>4400005</td></tr>
   <tr><td>85110006</td><td>4400006</td></tr>
  </tbody></table><div>共6条</div>`);
 const {window}=d;
 const endpoint='https://sc.scm121.com/api/company/after-sale/ipc/has-video';
 const fetch=async(url,{body})=>{
  const [id]=JSON.parse(body);
  return {ok:true,url,clone:()=>({json:async()=>({
   success:id!=='85110005',hasNext:id==='85110004',data:id==='85110001'?[85110001]:[],
  })})};
 };
 window.fetch=fetch;
 window.document.querySelector('#search').onclick=()=>{
  const request=(url,...ids)=>window.fetch(url,{method:'POST',body:JSON.stringify(ids)});
  void request(endpoint,'85110001','85110002');
  void request(endpoint.replace('sc.scm121.com','example.com'),'85110003');
  void request(endpoint,'85110004');
  void request(endpoint,'85110005');
  void request(endpoint,'85110006');
 };
 const frame={url:'https://www.erp321.com/afterSales',parent:null,executeJavaScript:async script=>window.eval(script)};
 frame.framesInSubtree=[frame];
 const observed=[];
 const reader=createReader({mainFrame:frame},async()=>({state:'authenticated',sourceCompany:base.sourceCompany}),undefined,
  rows=>observed.push(...rows));
 try{
  const result=await reader.query({...base,sourceColumns:true});
  assert.deepEqual(observed.map(row=>row.recordingStatus),['available','unavailable',undefined,undefined,undefined,'unavailable']);
  assert.ok(result.records.every(row=>!Object.hasOwn(row,'recordingStatus')));
  assert.equal(window.fetch,fetch);
 }finally{window.close();}
});
