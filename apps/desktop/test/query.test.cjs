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
 const result=await createReader(contents,async()=>{}).query({...base,from:'2026-11-04T00:00:00Z',until:'2026-11-04T01:00:00Z'},true);
 assert.equal(result.records.length,50);assert.equal(new Set(result.records.map(v=>v.afterSaleId)).size,50);assert.equal(result.hasNext,false);
});
test('latest range stops at its time boundary, excludes future/old cases and refuses missing or unsorted application times',()=>{
 const {latestPage}=require('../src/after-sales-query.cjs');const row=at=>({fields:{申请时间:at}});
 const values=[row('2026-11-04 10:00:00'),row('2026-11-04 09:30:00'),row('2026-11-04 08:00:00')];
 const result=latestPage(values,'2026-11-04T01:00:00Z','2026-11-04T01:45:00Z',true);assert.equal(result.records.length,1);assert.equal(result.records[0].fields['申请时间'],'2026-11-04 09:30:00');assert.equal(result.hasNext,false);
 assert.throws(()=>latestPage([values[1],values[0]],'2026-11-04T00:00:00Z','2026-11-04T02:00:00Z',true),/暂停/);
 assert.throws(()=>latestPage([{fields:{}}],'2026-11-04T00:00:00Z','2026-11-04T02:00:00Z',true),/暂停/);
});
test('an archive notice is not a query failure; actual error toasts are failures and credentials are scrubbed',()=>{
 const d=dom('<div class="ant-alert-error">订单已归档至2025-10-10，请在历史售后单查看</div>');
 assert.equal(d.window.eval(`(${domQuery.toString()})('state',{})`).error,null);
 const error=d.window.document.createElement('div');error.className='ant-message-error';error.textContent='请求失败 token=never-log https://erp321.com/?token=never-log';d.window.document.body.append(error);
 const result=d.window.eval(`(${domQuery.toString()})('state',{})`);assert.match(result.error,/请求失败/);assert.equal(result.error.includes('never-log'),false);
});
