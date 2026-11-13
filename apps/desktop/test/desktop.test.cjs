const {test}=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {allowedJst,oaOrigin,allowedOaNavigation,feishuClientLink,isAfterSalesLaunch,isAfterSalesSourceLaunch,trustedSender,boundsOf,pngBytes}=require('../src/security.cjs');
const {extractVisible,mergeFrames}=require('../src/extractor.cjs');
test('only exact HTTPS platform hosts, never lookalikes, credentials or local URLs',()=>{
 assert.equal(allowedJst('https://erp321.com/epaas'),true);assert.equal(allowedJst('https://innerorder.scm121.com/afterSales'),true);
 assert.equal(allowedJst('https://help.scm121.com/'),true);
 for(const url of ['https://erp321.com.evil.test','http://erp321.com','file:///etc/passwd','https://u:p@erp321.com','https://erp321.com:9000'])assert.equal(allowedJst(url),false);
 assert.equal(allowedJst('https://src.erp321.com/erp-web-group/home/'),false);
 assert.equal(allowedJst('https://src.erp321.com/erp-web-group/home/',{subframe:true}),true);
 assert.equal(allowedJst('https://src.erp321.com.evil.test/',{subframe:true}),false);
 assert.throws(()=>oaOrigin('https://evil.test',true));assert.throws(()=>oaOrigin('http://localhost:5173',true));assert.equal(oaOrigin('http://localhost:5173',false),'http://localhost:5173');
});
test('Feishu sign-in allows the passport redirect and OA callback on exact trusted origins', () => {
  const origin = 'https://lc.kudesi.com';
  assert.equal(allowedOaNavigation('https://accounts.feishu.cn/open-apis/authen/v1/authorize', origin), true);
  assert.equal(allowedOaNavigation('https://passport.feishu.cn/accounts/page/login', origin), true);
  assert.equal(allowedOaNavigation('https://login.feishu.cn/accounts/trap', origin), true);
  assert.equal(allowedOaNavigation('https://lc.kudesi.com/login?code=synthetic&state=synthetic', origin), true);
  assert.equal(allowedOaNavigation('https://passport.feishu.cn.evil.test/accounts/page/login', origin), false);
  assert.equal(allowedOaNavigation('https://passport.feishu.cn:8443/accounts/page/login', origin), false);
  assert.equal(allowedOaNavigation('https://u:p@passport.feishu.cn/accounts/page/login', origin), false);
  assert.equal(allowedOaNavigation('http://passport.feishu.cn/accounts/page/login', origin), false);
});
test('desktop login builds a Feishu AppLink only for this OA callback', () => {
  const origin = 'https://lc.kudesi.com';
  const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  url.search = new URLSearchParams({client_id:'cli_test',response_type:'code',redirect_uri:origin+'/login',state:'desktop.'+'a'.repeat(43)});
  const link = new URL(feishuClientLink(url.href, origin));
  assert.equal(link.protocol, 'feishu:');
  assert.equal(link.host + link.pathname, 'applink.feishu.cn/client/web_url/open');
  assert.equal(link.searchParams.get('url'), url.href);
  url.searchParams.set('redirect_uri', 'https://untrusted.example/login');
  assert.throws(() => feishuClientLink(url.href, origin));
  url.searchParams.set('redirect_uri', origin+'/login');
  url.hostname = 'accounts.feishu.cn.untrusted.example';
  assert.throws(() => feishuClientLink(url.href, origin));
});
test('IPC only from trusted OA main frame, never platform or subframes',()=>{
 const main={url:'https://lc.kudesi.com/after-sales/workspace'},webContents={mainFrame:main},win={webContents};
 assert.equal(trustedSender({sender:webContents,senderFrame:main},win,'https://lc.kudesi.com'),true);
 assert.equal(trustedSender({sender:{},senderFrame:main},win,'https://lc.kudesi.com'),false);
 assert.equal(trustedSender({sender:webContents,senderFrame:{url:main.url}},win,'https://lc.kudesi.com'),false);
});
test('the website protocol accepts only the fixed after-sales launch action',()=>{
 assert.equal(isAfterSalesLaunch('kudesi-oa://after-sales'),true);
 assert.equal(isAfterSalesLaunch('KUDESI-OA://AFTER-SALES/'),true);
 for(const value of ['kudesi-oa://after-sales?url=https://example.com','kudesi-oa://after-sales#access_token=x','kudesi-oa://after-sales/other','kudesi-oa://after-sales.example.com','kudesi-oa://user@after-sales','https://after-sales'])assert.equal(isAfterSalesLaunch(value),false);
 assert.equal(isAfterSalesSourceLaunch('kudesi-oa://after-sales/source'),true);
 assert.equal(isAfterSalesSourceLaunch('kudesi-oa://after-sales'),false);
 assert.equal(isAfterSalesSourceLaunch('kudesi-oa://after-sales/source?url=https://example.com'),false);
});
test('native bounds clamp to content viewport and reject non-finite values',()=>{
 assert.deepEqual(boundsOf({x:-20,y:20,width:1200,height:900},[800,600]),{x:0,y:20,width:800,height:580});
 assert.throws(()=>boundsOf({x:NaN,y:0,width:1,height:1},[800,600]));assert.throws(()=>pngBytes('data:text/html;base64,AAAA'));
});
function runDom(html,url,order){const dom=new JSDOM(html,{url,runScripts:'outside-only'});Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});dom.window.HTMLElement.prototype.getClientRects=function(){return this.hidden?[]:[{}];};return dom.window.eval(`(${extractVisible.toString()})(${JSON.stringify(order)})`);}
test('quick-filter fields preserve current status, historical snapshot and online type separately',()=>{
 const result=runDom(`<table><thead><tr><th>售后单号</th><th>内部订单号</th><th>线上类型</th><th>售后分类</th><th>线上状态</th><th>原订单状态</th><th>订单状态快照</th></tr></thead>
 <tbody><tr><td>85110001</td><td>4400001</td><td>仅退款</td><td><select><option selected>普通退货</option></select></td><td>等待卖家同意</td><td>已发货</td><td>已付款待审核</td></tr></tbody></table>`,'https://innerorder.scm121.com/afterSales');
 const fields=result.rows[0].fields;
 assert.equal(fields['线上类型'],'仅退款');
 assert.equal(fields['售后分类'],'普通退货');
 assert.equal(fields['线上状态'],'等待卖家同意');
 assert.equal(fields['原订单状态'],'已发货');
 assert.equal(fields['订单状态快照'],'已付款待审核');
});
test('ERP login state distinguishes a real shell, login form, and unavailable page',()=>{
 const {inspectJushuitanSession}=require('../src/jushuitan-session.cjs');
 const inspect=(html,url='https://www.erp321.com/epaas')=>{
   const dom=new JSDOM(html,{url,runScripts:'outside-only'});
   Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
   dom.window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
   try{return JSON.parse(dom.window.eval(`JSON.stringify((${inspectJushuitanSession.toString()})())`));}
   finally{dom.window.close();}
 };
 assert.deepEqual(inspect('<div>演示公司 [演示用户]</div>\n<nav role="menu">工作台</nav>'),
   {state:'authenticated',sourceCompany:'演示公司'});
 assert.deepEqual(inspect('<p>演示公司 [欢迎]</p>\n<nav role="menu">工作台</nav>\n<button>扫码登录</button>'),
   {state:'login_required'});
 assert.deepEqual(inspect('<form><input type="password" value="not-returned"><button>登录</button></form>'),
   {state:'login_required'});
 assert.deepEqual(inspect('<p>演示公司 [欢迎]</p>'),{state:'checking'});
 assert.deepEqual(inspect('<p>网站暂时无法访问</p>','https://www.erp321.com/error'),{state:'unavailable'});
});
test('extract list by headers, exclude hidden rows and page credentials',()=>{
 const r=runDom(`<p>演示公司 [客服]</p><div>password=do-not-save</div><table><thead><tr><th>售后单号</th><th>内部订单号</th><th>商品信息</th><th>线上状态</th><th>操作</th></tr></thead><tbody><tr><td>售后单号：851139355</td><td>4450075</td><td>演示种子 1袋</td><td>等待确认收货</td><td>秘密操作</td></tr><tr hidden><td>851139356</td><td>4450076</td><td>x</td><td>x</td><td>x</td></tr></tbody></table>`,'https://innerorder.scm121.com/afterSales');
 // jsdom has no innerText; use browser-compatible getter in fixture below.
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].afterSaleId,'851139355');assert.equal(r.rows[0].internalOrderId,'4450075');assert.equal(r.rows[0].fields['线上状态'],'等待确认收货');assert.equal(JSON.stringify(r).includes('do-not-save'),false);
});
test('extract solution, selected classification and displayed return tracking controls',()=>{
 const result=runDom(`
   <table><thead><tr><th>售后单号</th><th>内部订单号</th><th>解决方案</th><th>售后分类</th><th>退货快递单号</th><th>备注</th><th>卖家应退运费</th><th>仓库</th></tr></thead>
   <tbody>
     <tr><td>85110001</td><td>4400001</td><td>联系买家补寄</td><td>
       <select><option selected>退货退款</option><option>未选分类</option></select>
     </td><td><input value="示例快递"><input type="text" value="TEST12345">
       <input type="password" value="do-not-read"><input type="hidden" value="do-not-read"><input hidden value="do-not-read">
       <a>查看物流</a></td><td><input type="password" value="do-not-read"><input value="包装破损"><input hidden value="do-not-read"></td>
       <td><input role="spinbutton" value="0.00"></td><td><input type="search" value="do-not-read">
       <span class="ant-select-selection-item" title="示例退货仓">示例退…</span></td></tr>
     <tr><td>85110002</td><td>4400002</td><td></td><td>仅退款</td><td>示例快递 TEST67890 买家签收</td><td></td><td>12.30</td><td>仓库二</td></tr>
   </tbody></table>`, 'https://innerorder.scm121.com/afterSales');
 assert.equal(result.rows[0].fields['解决方案'],'联系买家补寄');
 assert.equal(result.rows[0].fields['售后分类'],'退货退款');
 assert.equal(result.rows[0].fields['退货快递单号'],'示例快递\nTEST12345');
 assert.equal(result.rows[1].fields['退货快递单号'],'示例快递 TEST67890 买家签收');
 assert.equal(result.rows[0].fields['备注'],'包装破损');
 assert.equal(result.rows[0].fields['卖家应退运费'],'0.00');
 assert.equal(result.rows[0].fields['仓库'],'示例退货仓');
 assert.equal(result.rows[1].fields['卖家应退运费'],'12.30');
 assert.equal(JSON.stringify(result).includes('do-not-read'),false);
});
test('merge detail only with matching internal order, preserve multiple after-sales',()=>{
 const result=mergeFrames([{sourceCompany:'示例公司',rows:[{afterSaleId:'85110000',internalOrderId:'4400000',fields:{线上状态:'待退货'}}],detail:[]},{sourceCompany:'',rows:[],detail:[{afterSaleId:'85110000',internalOrderId:'9900000',fields:{售后日志:'另一订单'}},{afterSaleId:'85110001',internalOrderId:'4400000',fields:{售后分类:'退货'}}]}]);
 assert.equal(result.length,2);assert.equal(result[0].internalOrderId,'4400000');assert.equal(result[0].fields['售后日志'],undefined);assert.equal(result[1].sourceCompany,'示例公司');
});
test('row-specific after-sales panels read only the intended visible dialog',async()=>{
 const {readAfterSalesPanel}=require('../src/after-sales-panels.cjs');
 const table=(headers,values)=>`<table><thead><tr>${headers.map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody><tr>${values.map(v=>`<td>${v}</td>`).join('')}</tr></tbody></table>`;
 const scenarios=[
  ['goods','商品信息 展示设置','商品明细','商品明细(选中对应明细编辑)',table(
   ['商品简称','类型','申请数量','实收数量／金额','次品数量','备注','原订单单价 / 采购价','进仓时间','操作'],
   ['演示品','退货','3','2 / 21.50','1','破损','12.00 / 10.00','2026-11-06','不得采集']),
   /演示品.*申请数量：3.*实收数量\/金额：2 \/ 21\.50.*次品数量：1.*原订单单价\/采购价：12\.00 \/ 10\.00.*进仓时间：2026-11-06/],
  ['refund','实退金额','查看明细','实退金额明细','<p>商品应退金额：21.50</p> <p>应退运费：2.00</p>',/商品应退金额：21\.50\n应退运费：2\.00/],
  ['logs','操作','查看日志','查看日志',table(['时间','操作人','操作','修改内容'],['2026-11-06','演示操作员','更新状态','已确认']),/演示操作员.*修改内容：已确认/],
  ['tracking','退货快递单号','TEST67890','物流（快递）跟踪信息',
   '<div class="art-table-body"><table><tbody><tr><td><span>2026-11-06 13:00</span></td><td>已签收</td><td>演示站签收</td></tr>'+
   '<tr><td>2026-11-06 09:00</td><td>派件</td><td>演示站开始派件</td></tr>'+
   '<tr hidden><td>2026-11-05 15:00</td><td>隐藏</td><td>不得采集</td></tr></tbody></table></div>',
   /^快递单号：TEST67890\n时间：2026-11-06 13:00 · 状态：已签收 · 物流描述：演示站签收\n时间：2026-11-06 09:00 · 状态：派件 · 物流描述：演示站开始派件$/],
  ['platform','平台售后详情','查看平台售后单详情','平台售后详情',table(['线上售后单号','处理结果'],['TEST001','待平台处理']),/TEST001.*待平台处理/],
  ['platform','平台售后详情','查看平台售后单详情','提示','当前售后单所在店铺是：\n测试店铺\n请确保该店铺为登录状态，否则无法正常查看平台售后单详情',/^店铺：测试店铺$/],
 ];
 for(const [kind,column,trigger,title,body,expected] of scenarios){
  const dom=new JSDOM(`<button id="unscoped">${trigger}</button><table><thead><tr><th>售后单号</th><th>${column}</th></tr></thead><tbody>
   <tr><td>85110002</td><td><button id="other">${trigger}</button></td></tr>
   <tr><td>售后单号：85110001</td><td><button id="target" aria-label="${trigger}">${kind==='platform'?'':trigger}</button></td></tr></tbody></table>
   <section role="dialog" aria-label="${title}" hidden><button aria-label="Close">关闭</button><div class="ant-modal-body">${body}</div></section>`,{runScripts:'outside-only'});
  const doc=dom.window.document;
  Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  dom.window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
  let unrelatedClicks=0;
  for(const id of ['unscoped','other'])doc.getElementById(id).onclick=()=>unrelatedClicks++;
  const panel=doc.querySelector('section');
  doc.getElementById('target').onclick=()=>{panel.hidden=false;};
  panel.querySelector('button').onclick=()=>{panel.hidden=true;};
  const readPanel=dom.window.eval(`(${readAfterSalesPanel.toString()})`);
  assert.equal((await readPanel('85110999',kind)).error,'原售后列表未显示这笔单据的明细入口');
  const result=await readPanel('85110001',kind);
  assert.match(result.content,expected,kind);
  assert.equal(result.content.includes('不得采集'),false);
  assert.equal(unrelatedClicks,0);
  assert.equal(panel.hidden,true);
  dom.window.close();
 }
});
test('金额只悬停同一行的省略号，拒绝原因只打开同一行的查看按钮',async()=>{
 const {readAfterSalesPanel}=require('../src/after-sales-panels.cjs');
 const dom=new JSDOM(`<table><thead><tr><th>售后单号</th><th>原订单下单金额</th><th>拒绝原因</th></tr></thead><tbody>
  <tr><td>85110002</td><td><span class="anticon-ellipsis" id="wrong-amount"></span></td><td><button id="wrong-reason">查看</button></td></tr>
  <tr><td>85110001</td><td><span class="anticon-ellipsis" id="amount"></span></td><td><button id="reason">查看</button></td></tr>
 </tbody></table><div class="ant-popover source-overlaySale" hidden><div class="ant-popover-inner-content">商品金额：30.00</div></div>
 <section class="ant-modal" hidden><div class="ant-modal-title">拒绝原因</div><div class="ant-modal-body">平台拒绝说明</div><button class="ant-modal-close"></button></section>`,{runScripts:'outside-only'});
 const {window}=dom, doc=window.document;
 Object.defineProperty(window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 const hits=[],popover=doc.querySelector('.ant-popover'),modal=doc.querySelector('.ant-modal');
 for(const el of doc.querySelectorAll('.anticon-ellipsis')){
  el.addEventListener('mouseover',()=>{hits.push(el.id);popover.hidden=false;});
  el.addEventListener('click',()=>hits.push('不应点击'));
  el.addEventListener('mouseout',()=>{popover.hidden=true;});
 }
 for(const el of doc.querySelectorAll('td button'))el.onclick=()=>{hits.push(el.id);modal.hidden=false;};
 modal.querySelector('button').onclick=()=>{modal.hidden=true;};
 const read=window.eval(`(${readAfterSalesPanel.toString()})`);
 assert.equal((await read('85110001','orderAmount')).content,'商品金额：30.00');
 assert.equal((await read('85110001','refusal')).content,'平台拒绝说明');
 assert.deepEqual(hits,['amount','reason']);
 assert.equal(popover.hidden&&modal.hidden,true);
 window.close();
});

test('read-only refund details reopen a hover popover that is still leaving',async()=>{
 const {readAfterSalesPanel}=require('../src/after-sales-panels.cjs');
 const dom=new JSDOM('<table><thead><tr><th>售后单号</th><th>实退金额</th></tr></thead><tbody><tr><td>85110001</td><td><button>查看明细</button></td></tr></tbody></table><div class="ant-popover" id="other">商品应退金额：99.00 应退运费：5.00</div><div class="ant-popover zoom-big-leave" id="target">商品应退金额：21.50 应退运费：2.00</div>',{runScripts:'outside-only'});
 const doc=dom.window.document;
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 dom.window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 const target=doc.getElementById('target'),other=doc.getElementById('other');
 const trigger=doc.querySelector('button');
 trigger.onmouseover=()=>target.classList.remove('zoom-big-leave');
 trigger.onmouseout=event=>{if(event.relatedTarget===doc.body)target.classList.add('zoom-big-leave');};
 try{
  const read=()=>dom.window.eval('('+readAfterSalesPanel.toString()+')("85110001","refund")');
  for(let attempt=0;attempt<2;attempt++){
   assert.equal((await read()).content,'商品应退金额：21.50\n应退运费：2.00');
   assert.equal(target.classList.contains('zoom-big-leave'),true);
   assert.equal(other.hidden,false);
  }
 }finally{dom.window.close();}
});
test('older OA pages keep receiving a snapshot with only fields they accept',()=>{
 const {legacySnapshot}=require('../src/after-sales-query.cjs');
 const current={afterSaleId:'85110001',fields:{解决方案:'补寄',退货物流状态:'已签收',退货金额:'15.50',售后单状态:'已确认'}};
 assert.deepEqual(legacySnapshot(current).fields,{物流状态:'已签收',售后单状态:'已确认'});
 assert.equal(current.fields['退货金额'],'15.50');
});
test('nested detail keeps after-sales separated and reads totals, logistics and logs',()=>{
 const r=runDom(`<pre>订单编号：4400001\n买家留言：(无)\n实际已付：54.29\n快递公司：演示快递\n售后单号：85110001\n申请金额：54.29\n退回快递单号：DEMO111\n售后单号：85110002\n申请金额：30.00\n退回快递单号：DEMO222\n订单操作进程及日志\n2026-11-04 接单</pre>`,'https://erp321.com/app/order/order/OrderEditorNew.aspx?jmxToken=never-persist');
 assert.equal(r.detail.length,2);assert.equal(r.detail[0].internalOrderId,'4400001');assert.equal(r.detail[0].fields['线上申请金额'],'54.29');assert.equal(r.detail[1].fields['线上申请金额'],'30.00');assert.equal(r.detail[0].fields['退货快递单号'],'DEMO111');assert.equal(r.detail[1].fields['退货快递单号'],'DEMO222');assert.equal(r.detail[0].fields['实际已付'],'54.29');assert.match(r.detail[0].fields['订单操作日志'],/接单/);assert.equal(JSON.stringify(r).includes('never-persist'),false);
});
test('order without an after-sales section only attaches to the exact requested order',()=>{
 const html='<pre>订单编号：4400001\n实际已付：54.29</pre>';
 const url='https://erp321.com/app/order/order/OrderEditorNew.aspx';
 assert.equal(runDom(html,url).detail.length,0);
 assert.equal(runDom(html,url,{internalOrderId:'4400002',afterSaleId:'85110001'}).detail.length,0);
 const result=runDom(html,url,{internalOrderId:'4400001',afterSaleId:'85110001'});
 assert.equal(result.detail[0].afterSaleId,'85110001');
 assert.equal(result.detail[0].fields['实际已付'],'54.29');
});
test('internal-order opener cannot click another numeric business action',()=>{
 const {openVisibleOrder}=require('../src/extractor.cjs');
 const dom=new JSDOM('<button id="refund">4400001</button><table><thead><tr><th>内部订单号</th><th>操作</th></tr></thead><tbody><tr><td><button id="order">4400001</button></td><td><button id="other">9900001</button></td></tr></tbody></table>',{runScripts:'outside-only'});
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});dom.window.HTMLElement.prototype.getClientRects=()=>[{}];let order=0,other=0;dom.window.document.getElementById('order').onclick=()=>order++;dom.window.document.getElementById('other').onclick=()=>other++;dom.window.document.getElementById('refund').onclick=()=>other++;
 assert.equal(dom.window.eval(`(${openVisibleOrder.toString()})('4400001')`),true);assert.equal(order,1);assert.equal(other,0);assert.equal(dom.window.eval(`(${openVisibleOrder.toString()})('9900001')`),false);assert.equal(other,0);
});
test('original sale action clicks only the matching sale link, not an order or a neighboring sale',()=>{
 const {openVisibleOrder}=require('../src/extractor.cjs');
 const dom=new JSDOM(`<table><thead><tr><th>售后单号</th><th>内部订单号</th></tr></thead><tbody>
   <tr><td><button id="other">85110002</button></td><td><button id="order">85110001</button></td></tr>
   <tr><td><button id="sale">85110001</button></td><td><button>4400001</button></td></tr>
   </tbody></table>`,{runScripts:'outside-only'});
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 dom.window.HTMLElement.prototype.getClientRects=()=>[{}];
 const clicked=[];
 for(const id of ['sale','other','order'])dom.window.document.getElementById(id).onclick=()=>clicked.push(id);
 assert.equal(dom.window.eval(`(${openVisibleOrder.toString()})('85110001','85110001','sale')`),true);
 assert.deepEqual(clicked,['sale']);
 dom.window.close();
});
test('ERP split header/body tables are read together',()=>{
 const r=runDom('<div><div><table><thead><tr><th>售后单号</th><th>内部订单号</th><th>线上状态</th></tr></thead></table></div><div><table><tbody><tr><td>售后单号：85110001</td><td><button>4400001</button></td><td>等待退货</td></tr></tbody></table></div></div>','https://innerorder.scm121.com/afterSales');
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].afterSaleId,'85110001');assert.equal(r.rows[0].fields['线上状态'],'等待退货');
});
test('legacy order goods table without thead retains items, never cost columns',()=>{
 const r=runDom('<pre>订单编号：4400001\n售后单号：85110001\n申请金额：54.29\n</pre><table><tbody><tr><td>商品信息</td><td>数量</td><td>单价</td><td>成本</td></tr><tr><td>演示商品</td><td>2</td><td>27.145</td><td>secret-cost</td></tr></tbody></table>','https://erp321.com/app/order/order/OrderEditorNew.aspx');assert.match(r.detail[0].fields['商品明细'],/演示商品/);assert.match(r.detail[0].fields['商品明细'],/数量：2/);assert.equal(JSON.stringify(r).includes('secret-cost'),false);
});
test('initial hotkey stays registered and a conflict preserves the previous key',()=>{
 const {replaceShortcut}=require('../src/security.cjs');const keys=new Set(),shortcut={isRegistered:k=>keys.has(k),register:k=>{if(k==='Control+X')return false;keys.add(k);return true;},unregister:k=>keys.delete(k)};
 assert.equal(replaceShortcut(shortcut,'Control+Shift+S','Control+Shift+S',()=>{}),true);assert.equal(keys.has('Control+Shift+S'),true);
 assert.equal(replaceShortcut(shortcut,'Control+Shift+S','Control+X',()=>{}),false);assert.equal(keys.has('Control+Shift+S'),true);
 assert.equal(replaceShortcut(shortcut,'Control+Shift+S','Alt+S',()=>{}),true);assert.equal(keys.has('Control+Shift+S'),false);assert.equal(keys.has('Alt+S'),true);
});
test('visible order form values are captured, hidden and password fields are never captured',()=>{
 const r=runDom('<pre>订单编号：4400001\n售后单号：85110001\n</pre><table><tr><td>收货人：</td><td><input value="演示买家"><input type="password" value="do-not-read"><input hidden value="hidden-value"></td></tr></table>','https://erp321.com/app/order/order/OrderEditorNew.aspx');assert.equal(r.detail[0].fields['收货人'],'演示买家');assert.equal(JSON.stringify(r).includes('do-not-read'),false);assert.equal(JSON.stringify(r).includes('hidden-value'),false);
});
test('legacy JT grid maps archived source labels and ignores hidden refund-account columns',()=>{
 const r=runDom('<p>演示公司 [客服]</p><div><div><div><div class="_jt_cell_head">售后单号</div><div class="_jt_cell_head">内部订单号</div><div class="_jt_cell_head">申请日期</div><div class="_jt_cell_head">状态</div><div hidden class="_jt_cell_head">买家退款账号</div></div></div><div class="_jt_row"><div>85110001</div><div><a>4400001</a></div><div>2025-10-09 12:00:00</div><div>已确认</div><div>never-read-bank</div></div></div>','https://erp321.com/app/Service/aftersale/aftersale.aspx');
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].fields['申请时间'],'2025-10-09 12:00:00');assert.equal(r.rows[0].fields['售后单状态'],'已确认');assert.equal(JSON.stringify(r).includes('never-read-bank'),false);
});
test('原订单备注和旗帜分别从聚水潭的备注容器和旗帜图标读取',()=>{
 const dom=new JSDOM(`<table><thead><tr><th>售后单号</th><th>内部订单号</th><th>原订单备注/旗帜</th></tr></thead><tbody>
  <tr><td>85110001</td><td>4400001</td><td>
    <svg aria-hidden="true" style="color:rgb(244, 67, 54)"><use href="#icon-qizhi"></use></svg>
    <div class="ellipsis-2-line t-left">客户已联系</div>
    <svg style="color:rgb(67, 142, 247)"><use href="#icon-bianji1"></use></svg>
    <span title="编辑"></span>
  </td></tr>
  <tr><td>85110002</td><td>4400002</td><td><div class="ellipsis-2-line t-left"></div><span title="编辑"></span></td></tr>
 </tbody></table>`,{runScripts:'outside-only'});
 const {window}=dom;
 Object.defineProperty(window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 window.Element.prototype.getClientRects=()=>[{}];
 const {rows}=window.eval(`(${extractVisible.toString()})(null)`);
 assert.deepEqual(JSON.parse(JSON.stringify(rows.map(row=>row.fields))),[
  {'原订单备注/旗帜':'客户已联系','原订单旗帜':'#f44336'},
  {'原订单备注/旗帜':'','原订单旗帜':''},
 ]);
});

test('each archived source field can be captured from its visible list column',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const shared=fs.readFileSync(path.join(__dirname,'../../../packages/shared/src/desktop-after-sales.ts'),'utf8');
 const block=shared.match(/const AFTER_SALES_TEXT_FIELDS = \[(.*?)\] as const;/)[1];
 const fields=[...block.matchAll(/'([^']+)'/g)].map(m=>m[1]);
 const r=runDom(`<table><thead><tr><th>售后单号</th><th>内部订单号</th>${fields.map(f=>`<th>${f}</th>`).join('')}</tr></thead><tbody><tr><td>85110001</td><td>4400001</td>${fields.map((_,i)=>`<td>字段 ${i}</td>`).join('')}</tr></tbody></table>`,'https://erp321.com/epaas');
 assert.deepEqual(Object.keys(r.rows[0].fields),fields);
 assert.equal(r.rows[0].fields[fields.at(-1)],`字段 ${fields.length-1}`);
});
test('list aliases, icon labels and hidden field cells are handled without reading image URLs',()=>{
 const r=runDom('<table><thead><tr><th>售后单号</th><th>内部订单号</th><th>申请日期</th><th>买家图片凭证</th><th>卖家退款账号</th></tr></thead><tbody><tr><td>85110001</td><td>4400001</td><td>2026-11-06 10:00:00</td><td><img alt="买家凭证" src="https://example.test/private"></td><td hidden>不读取</td></tr></tbody></table>','https://erp321.com/epaas');
 assert.deepEqual({...r.rows[0].fields},{申请时间:'2026-11-06 10:00:00',买家图片凭证:'买家凭证'});
});

test('ERP field navigation scrolls only the exact matching row and leaves its controls untouched',()=>{
 const {locateJushuitanField}=require('../src/jushuitan-source-field.cjs');
 const dom=new JSDOM(`
  <section><table><thead><tr><th>售后单号</th><th>标记|多标签</th><th>操作</th></tr></thead></table>
  <table><tbody><tr><td>85110002</td><td id="other"><button>修改</button></td><td><button>编辑</button></td></tr>
  <tr><td>85110001</td><td id="target"><button>修改</button></td><td id="actions"><button>查看日志</button><button id="editor">编辑</button></td></tr></tbody></table></section>
 `,{runScripts:'outside-only'});
 const {window}=dom;
 const events=[];
 window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 window.HTMLElement.prototype.scrollIntoView=function(){events.push(this.id);};
 window.document.addEventListener('click',()=>events.push('clicked'));
 const locate=window.eval(`(${locateJushuitanField.toString()})`);
 try {
  assert.equal(locate('85110001','售后标签'),true);
  assert.equal(locate('85110001','操作'),true);
  assert.equal(locate('85110001','退款'),false);
  assert.equal(locate('00000000','售后标签'),false);
  assert.deepEqual(events,['target','editor']);
  assert.equal(window.document.getElementById('other').hasAttribute('data-oa-source-field'),false);
  assert.equal(window.document.getElementById('target').hasAttribute('data-oa-source-field'),true);
 } finally {window.close();}
});

test('原字段直接打开精确的编辑和附件入口，忽略同行其它按钮',()=>{
 const {locateJushuitanField}=require('../src/jushuitan-source-field.cjs');
 const dom=new JSDOM(`<table><thead><tr><th>售后单号</th><th>售后问题登记</th><th>操作</th></tr></thead><tbody>
  <tr><td>85110002</td><td><svg id="other"><use href="#icon-bianji1"/></svg></td><td><button>编辑</button></td></tr>
  <tr><td>85110001</td><td><svg id="edit-note" aria-hidden="true" style="visibility:hidden"><use href="#icon-bianji1" style="cursor:pointer"/></svg>
   <button id="upload"><svg><use href="#icon-dingdandaochu3"/></svg>上传图片备注</button>
   <button id="download"><svg><use href="#icon-dingdandaochu3"/></svg>下载附件</button></td>
   <td><button id="log">查看日志</button><button id="edit-sale">编辑</button><button>确认</button></td></tr>
 </tbody></table>`,{runScripts:'outside-only'});
 const {window}=dom, doc=window.document;
 window.Element.prototype.getClientRects=()=>[{}];
 Object.defineProperty(window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 const hits=[];
 doc.addEventListener('click',event=>hits.push(event.target.id));
 const open=window.eval(`(${locateJushuitanField.toString()})`);
 assert.equal(open('85110001','售后问题登记',false,'open'),true);
 assert.equal(open('85110001','售后问题登记',false,'attachment'),true);
 assert.equal(open('85110001','操作',false,'open'),true);
 assert.equal(open('85110002','售后问题登记',false,'attachment'),false);
 assert.deepEqual(hits,['edit-note','download','edit-sale']);
 window.close();
});

test('售后视频只打开指定行内唯一可用的监控入口',()=>{
 const {locateJushuitanField}=require('../src/jushuitan-source-field.cjs');
 const dom=new JSDOM(`
  <button id="toolbar">视频监控</button>
  <table><thead><tr><th>售后单号</th><th>操作</th></tr></thead><tbody>
    <tr><td><button>85110002</button></td><td><button id="other" title="视频监控">视频</button></td></tr>
    <tr><td><button>85110001</button> 标记</td><td>
      <button id="blocked" disabled>视频监控</button>
      <button id="target" title="点击观看视频"><svg></svg></button>
      <button id="manage">视频监控设备管理</button>
    </td></tr>
  </tbody></table>`,{runScripts:'outside-only'});
 const {window}=dom;
 window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 const opened=[];
 window.document.addEventListener('click',event=>opened.push(event.target.id));
 const locate=window.eval(`(${locateJushuitanField.toString()})`);
 try {
  assert.equal(locate('85110001',null,true),true);
  assert.deepEqual(opened,['target']);
  assert.equal(locate('85110009',null,true),false);
  window.document.getElementById('blocked').disabled=false;
  assert.equal(locate('85110001',null,true),false);
  assert.deepEqual(opened,['target']);
 } finally {window.close();}
});

test('售后列表只采用原页明确显示的录像状态',()=>{
 const {readJushuitanRecordingStatus}=require('../src/jushuitan-recording-status.cjs');
 const dom=new JSDOM(`<table><thead><tr><th>售后单号</th><th>内部订单号</th><th>录像状态</th><th>操作</th><th>备注</th></tr></thead><tbody>
  <tr><td>85110001</td><td>4400001</td><td>有</td><td><button>视频监控</button></td><td></td></tr>
  <tr><td>85110002</td><td>4400002</td><td></td><td><button title="视频监控：无录像" disabled>视频监控</button></td><td></td></tr>
  <tr><td>85110003</td><td>4400003</td><td></td><td><button disabled>视频监控</button><span hidden>无录像</span></td><td><span>有录像</span></td></tr>
  <tr><td>85110004</td><td>4400004</td><td>有录像</td><td><span title="无录像"></span></td><td></td></tr>
  <tr><td>85110005</td><td>4400005</td><td></td><td></td><td><span title="点击观看视频"></span></td></tr>
  <tr><td>85110006</td><td>4400006</td><td></td><td><span title="售后单以及其关联的订单均未有监控视频录制，无法查看视频"></span></td><td></td></tr>
  <tr><td>85110007</td><td>4400007</td><td></td><td></td><td>点击观看视频<span hidden title="点击观看视频"></span></td></tr>
 </tbody></table>`,{runScripts:'outside-only'});
 const {window}=dom;
 Object.defineProperty(window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 try {
  const raw=window.eval(`(${extractVisible.toString()})(null,${readJushuitanRecordingStatus.toString()})`);
  assert.deepEqual(Array.from(raw.rows,record=>record.recordingStatus),['available','unavailable',undefined,undefined,undefined,'unavailable',undefined]);
  assert.equal(raw.rows.some(record=>Object.hasOwn(record.fields,'录像状态')),false);
 } finally {window.close();}
});

test('旧版只用同单有录像的图标打开官方播放器',()=>{
 const {classicRecordingAction}=require('../src/jushuitan-recording-player.cjs');
 const dom=new JSDOM(`
  <div class="_jt_row"><span class="event_delegation_id">85110001</span>
   <span class="event_delegation_ipcvideo" title="点击观看视频" ipc_info='{"biz_id":85110001,"has_ipc_video":true}' id="target"></span></div>
  <div class="_jt_row"><span class="event_delegation_id">85110002</span>
   <span class="event_delegation_ipcvideo" title="点击观看视频" ipc_info='{"biz_id":85110001,"has_ipc_video":true}' id="mismatch"></span></div>
 `,{runScripts:'outside-only'});
 const {window}=dom;
 window.HTMLElement.prototype.getClientRects=()=>[{}];
 const clicked=[];
 window.document.addEventListener('click',event=>clicked.push(event.target.id));
 const action=window.eval(`(${classicRecordingAction.toString()})`);
 try{
  window.JstPrint={getJstClientVersion:()=>0};
  assert.equal(action('85110001',true).state,'helper-required');
  window.JstPrint.getJstClientVersion=()=>3147104;
  window._hasIpcViewPermissions=false;
  assert.equal(action('85110001',true).state,'denied');
  window._hasIpcViewPermissions=true;
  assert.equal(action('85110002',true).state,'missing');
  assert.equal(action('85110001',true).state,'opened');
  assert.deepEqual(clicked,['target']);
 }finally{window.close();}
});

test('只放大本次选定的原站播放器框架，关闭后清除样式',()=>{
 const {focusRecordingFrame}=require('../src/jushuitan-recording-player.cjs');
 const url='https://src.erp321.com/erp-web-group/erp-oms-ip-camera/scene';
 const dom=new JSDOM(`<iframe id="source" src="${url}"></iframe><iframe id="other" src="https://example.com/erp-web-group/erp-oms-ip-camera/scene"></iframe>`,{runScripts:'outside-only'});
 const {window}=dom;
 window.HTMLElement.prototype.getClientRects=()=>[{}];
 const focus=window.eval(`(${focusRecordingFrame.toString()})`);
 const parsed=new URL(url);
 try{
  assert.equal(focus({origin:parsed.origin,path:parsed.pathname}),true);
  assert.equal(window.document.querySelector('iframe[data-oa-recording-frame]').id,'source');
  assert.equal(focus(null),true);
  assert.equal(window.document.querySelector('iframe[data-oa-recording-frame]'),null);
  assert.equal(window.document.getElementById('data-oa-recording-frame'),null);
 }finally{window.close();}
});

test('售后自动截图松开鼠标即提交选区',async()=>{
 const fs=require('node:fs');
 const dom=new JSDOM('<canvas id="canvas"></canvas><div id="hint"></div><div id="tools" hidden><button id="attach"></button><button id="undo"></button><button id="crop"></button><span id="error"></span></div>',{runScripts:'outside-only'});
 const {window}=dom,canvas=window.document.getElementById('canvas'),calls=[];
 window.HTMLCanvasElement.prototype.getContext=()=>new Proxy({},{get:()=>()=>{}});
 window.HTMLCanvasElement.prototype.toDataURL=()=> 'data:image/png;base64,AAAA';
 canvas.setPointerCapture=()=>{};
 let onImage;
 window.captureEditor={onImage:receive=>{onImage=receive;},finish:async(...args)=>{calls.push(args);}};
 try{
  window.eval(fs.readFileSync(require.resolve('../src/shot-editor.cjs'),'utf8'));
  onImage({image:'data:image/png;base64,AAAA',canAttach:true,autoAttach:true});
  canvas.onpointerdown({button:0,pointerId:1,clientX:10,clientY:10});
  canvas.onpointerup({clientX:240,clientY:240});
  assert.deepEqual(calls,[['attach','data:image/png;base64,AAAA']]);
  assert.equal(window.document.getElementById('tools').hidden,true);
 }finally{window.close();}
});

test('OA 详情只读已匹配的原单，区分售后商品和订单商品并保留显示值',()=>{
 const {readJushuitanDocument}=require('../src/jushuitan-document.cjs');
 const {readPublicGoodsImage}=require('../src/goods-images.cjs');
 const identity={afterSaleId:'85110001',internalOrderId:'4400001',sourceCompany:'示例公司'};
 for(const kind of ['sale','order']){
  const sale=kind==='sale';
  const dom=new JSDOM(`<span id="o_id">4400001</span><span id="as_id">${sale?'85110001':''}</span>
   <p><span class="head_text">${sale?'快递登记':'快递公司'}：</span><input type="hidden" value="禁止读取"><span>样例值</span></p>
   <p><span class="head_text">备注：</span><input type="password" value="禁止读取"></p>
   <table id="item_list"><thead><tr><th>图片</th><th>商品信息</th><th>${sale?'申请数量(回车保存)':'数量'}</th><th>操作</th></tr></thead>
   <tbody><tr><td><img src="https://img.pddpic.com/goods/a.jpg"></td><td>样例商品</td><td><input type="text" value="2"></td><td>保存</td></tr>
   <tr><td><img src="https://img.pddpic.com/goods/b.jpg?token=hidden"></td><td>第二个商品</td><td>1</td><td>保存</td></tr></tbody></table>
   <div id="actions">样例日志</div>`,
   {url:'https://erp321.com'+(sale?'/app/Service/aftersale/editor.aspx':'/app/order/order/OrderEditorNew.aspx'),runScripts:'outside-only'});
  const {window}=dom;
  Object.defineProperty(window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
  const read=window.eval(`(${readJushuitanDocument.toString()})`);
  assert.equal(read({...identity,internalOrderId:'4409999'},kind),null);
  if(sale)assert.equal(read({...identity,afterSaleId:'85119999'},kind),null);
  const result=read(identity,kind,readPublicGoodsImage),fields=result.fields;
  assert.deepEqual([...result.productImages],['https://img.pddpic.com/goods/a.jpg','']);
  assert.equal(fields[sale?'快递登记':'快递公司'],'样例值');
  assert.equal(fields[sale?'售后详情操作日志':'订单操作日志'],'样例日志');
  assert.deepEqual(JSON.parse(fields[sale?'售后详情商品明细':'商品明细']),{
   columns:['商品信息',sale?'申请数量':'数量'],rows:[['样例商品','2'],['第二个商品','1']],
  });
  assert.equal(JSON.stringify(fields).includes('禁止读取'),false);
  window.close();
 }
});

test('快递100只读已选标签的结果，不串入系统物流记录',async()=>{
 const {readAfterSalesPanel}=require('../src/after-sales-panels.cjs');
 const dom=new JSDOM(`<table><thead><tr><th>售后单号</th><th>发货快递单号</th></tr></thead>
  <tbody><tr><td>85110001</td><td><button id="open">SF123456789</button></td></tr></tbody></table>
  <section role="dialog" aria-label="物流（快递）跟踪信息" hidden>
   <button class="ant-modal-close">关闭</button>
   <button id="provider" role="tab" aria-controls="provider-content" aria-selected="false">快递100查询</button>
   <div id="system"><div class="ant-timeline-item-content">系统记录</div></div>
   <div id="provider-content" role="tabpanel" hidden><div class="ant-timeline-item-content">快递100记录</div></div>
  </section>`,{runScripts:'outside-only'});
 const {window}=dom, doc=window.document;
 Object.defineProperty(window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 const modal=doc.querySelector('section'),tab=doc.getElementById('provider');
 doc.getElementById('open').onclick=()=>{modal.hidden=false;};
 tab.onclick=()=>{tab.setAttribute('aria-selected','true');doc.getElementById('provider-content').hidden=false;};
 modal.querySelector('.ant-modal-close').onclick=()=>{modal.hidden=true;};
 const read=window.eval(`(${readAfterSalesPanel.toString()})`);
 const result=await read('85110001','shipping',{queryProvider:true});
 assert.match(result.content,/快递100记录/);
 assert.doesNotMatch(result.content,/系统记录/);
 tab.onclick=()=>{
  tab.setAttribute('aria-selected','true');
  const pane=doc.getElementById('provider-content');
  pane.hidden=false;
  pane.innerHTML='<iframe src="https://m.kuaidi100.com/result.jsp?nu=SF123456789&amp;com=shunfeng&amp;token=secret"></iframe>';
 };
 assert.equal((await read('85110001','shipping',{queryProvider:true})).providerUrl,
  'https://m.kuaidi100.com/result.jsp?nu=SF123456789&com=shunfeng');
 assert.equal(modal.hidden,true);
 window.close();
});

test('发货物流按售后单号和运单定位，并保留有无状态列的轨迹',async()=>{
 const {readAfterSalesPanel}=require('../src/after-sales-panels.cjs');
 const {window}=new JSDOM(`<table><thead><tr><th>售后单号</th><th>发货快递单号</th></tr></thead>
  <tbody>
   <tr><td>85110002</td><td><button id="other">YT123456789</button></td></tr>
   <tr><td>85110001</td><td><button id="first">SF123456789</button> <button id="match">YT123456789</button></td></tr>
  </tbody></table>
  <section role="dialog" aria-label="物流（快递）跟踪信息" hidden>
   <button class="ant-modal-close">关闭</button>
   <table><thead><tr><th>发生时间</th><th>快递状态</th><th>轨迹描述</th></tr></thead><tbody>
    <tr><td>2026-11-06 13:00:00</td><td>已签收</td><td>仓库签收</td></tr>
    <tr><td>2026/11/6 10:00</td><td>送往仓库</td></tr>
    <tr><td colspan="3">共有两条轨迹</td></tr>
    <tr hidden><td>2026-11-05 15:00</td><td>隐藏状态</td><td>隐藏描述</td></tr>
   </tbody></table>
  </section>`,{runScripts:'outside-only'});
 const doc=window.document,modal=doc.querySelector('section'),clicked=[];
 Object.defineProperty(window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 for(const id of ['first','match','other'])doc.getElementById(id).onclick=()=>{clicked.push(id);modal.hidden=false;};
 modal.querySelector('.ant-modal-close').onclick=()=>{modal.hidden=true;};
 const read=window.eval(`(${readAfterSalesPanel.toString()})`);
 try{
  const result=await read('85110001','shipping',{waybill:'YT123456789'});
  assert.deepEqual(clicked,['match']);
  assert.equal(result.content,[
   '快递单号：YT123456789',
   '时间：2026-11-06 13:00:00 · 状态：已签收 · 物流描述：仓库签收',
   '时间：2026/11/6 10:00 · 物流描述：送往仓库',
  ].join('\n'));
  assert.equal((await read('85110001','shipping',{waybill:'YT987654321'})).missingTrigger,true);
  assert.deepEqual(clicked,['match']);
  assert.equal(modal.hidden,true);
 }finally{window.close();}
});

test('退货物流等待旧版列表弹窗中的异步轨迹，确认无数据时结束读取',async()=>{
 const {readAfterSalesPanel}=require('../src/after-sales-panels.cjs');
 const {window}=new JSDOM(`<div><div><div class="_jt_cell_head">售后单号</div><div class="_jt_cell_head">退回快递单号(运单号)</div></div>
  <div class="_jt_row"><div>85110001</div><div><input value="ZTO123456789"><button id="open">查看物流</button></div></div>
  </div><section role="dialog" aria-label="物流详情" hidden><button class="ant-modal-close">关闭</button><div id="result"></div></section>`,
  {runScripts:'outside-only'});
 const doc=window.document,modal=doc.querySelector('section'),body=doc.getElementById('result');
 Object.defineProperty(window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 let hasTracks=true;
 doc.getElementById('open').onclick=()=>{
  modal.hidden=false;
  body.innerHTML='<div class="art-table-empty">暂无物流</div>';
  if(hasTracks)window.setTimeout(()=>{
   body.innerHTML='<table><tbody><tr><td>查询说明</td></tr><tr><td>2026-11-06 12:31</td><td>退回件已揽收</td></tr></tbody></table>';
  },30);
 };
 modal.querySelector('.ant-modal-close').onclick=()=>{modal.hidden=true;};
 const read=window.eval(`(${readAfterSalesPanel.toString()})`);
 try{
  const result=await read('85110001','tracking',{waybill:'ZTO123456789'});
  assert.equal(result.content,'快递单号：ZTO123456789\n时间：2026-11-06 12:31 · 物流描述：退回件已揽收');
  hasTracks=false;
  let now=0;
  window.Date.now=()=>now+=4000;
  assert.equal((await read('85110001','tracking',{waybill:'ZTO123456789'})).empty,true);
  assert.equal(modal.hidden,true);
 }finally{window.close();}
});

test('优惠只读取当前订单支付表或本次打开的明细，保留同名优惠各行',async()=>{
 const {readJushuitanOrderDiscount}=require('../src/jushuitan-order-discount.cjs');
 const dom=new JSDOM(`<table id="revenue_statistics"><tr><td><span id="show_revenue_statistics_item">查看优惠明细</span></td></tr>
  <tr><td><span>支付优惠：</span><span>5.00</span></td><td>店铺优惠：2.00</td></tr></table>
  <section role="dialog" id="wrong">优惠明细<table><tr><td>优惠券：999.00</td></tr></table></section>
  <section role="dialog" id="target" hidden>优惠明细<table><tr><td>优惠券：2.00</td></tr><tr><td>优惠券：3.00</td></tr></table></section>`,{runScripts:'outside-only'});
 const {window}=dom,doc=window.document;
 Object.defineProperty(window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 doc.getElementById('show_revenue_statistics_item').onclick=()=>{doc.getElementById('target').hidden=false;};
 const read=window.eval(`(${readJushuitanOrderDiscount.toString()})`);
 assert.deepEqual(JSON.parse(JSON.stringify(await read())),{summary:false,items:[['优惠券','2.00'],['优惠券','3.00']]});
 doc.getElementById('show_revenue_statistics_item').onclick=null;
 assert.deepEqual(JSON.parse(JSON.stringify(await read())),{summary:true,items:[['支付优惠','5.00'],['店铺优惠','2.00']]});
 window.close();
});

test('OA 录像只挂载本次在对应行打开的播放器，关闭时停止播放',async()=>{
 const {locateJushuitanField}=require('../src/jushuitan-source-field.cjs');
 const {prepareJushuitanRecording,dismissJushuitanRecording}=require('../src/jushuitan-recording-player.cjs');
 const dom=new JSDOM(`<video id="older" src="/old.mp4"></video><table><thead><tr><th>售后单号</th><th>操作</th></tr></thead>
  <tbody><tr><td>85110001</td><td><button id="target">视频监控</button></td></tr>
  <tr><td>85110002</td><td>暂无录像</td></tr></tbody></table>`,{url:'https://erp321.com/afterSales',runScripts:'outside-only'});
 const {window}=dom,doc=window.document;
 Object.defineProperty(window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 let paused=0;
 window.HTMLMediaElement.prototype.pause=()=>paused++;
 doc.getElementById('target').onclick=()=>{
  const modal=doc.createElement('section');modal.setAttribute('role','dialog');
  modal.innerHTML='<button aria-label="关闭">关闭</button><video src="/selected.mp4"></video>';
  doc.body.append(modal);
  modal.querySelector('button').onclick=()=>modal.remove();
 };
 const prepare=window.eval(`(${prepareJushuitanRecording.toString()})`);
 const locate=window.eval(`(${locateJushuitanField.toString()})`);
 assert.equal((await prepare('85110002',locate)).state,'missing');
 assert.equal((await prepare('85110001',locate)).state,'ready');
 assert.equal(doc.querySelector('[data-oa-recording-root] video')?.getAttribute('src'),'/selected.mp4');
 window.eval(`(${dismissJushuitanRecording.toString()})()`);
 assert.equal(paused,1);
 assert.equal(doc.querySelector('[data-oa-recording-root]'),null);
 assert.ok(doc.getElementById('older'));
 window.close();
});


test('录像图标携带的售后身份必须匹配当前行',()=>{
 const {readJushuitanRecordingStatus}=require('../src/jushuitan-recording-status.cjs');
 const d=new JSDOM(`<table><tbody><tr><td>85110001</td><td><span ipc_info='{"biz_id":85110002,"has_ipc_video":true}' title="点击观看视频"></span></td></tr></tbody></table>`,{runScripts:'outside-only'});
 d.window.HTMLElement.prototype.getClientRects=()=>[{}];
 const read=()=>d.window.eval(`(${readJushuitanRecordingStatus.toString()})(document.querySelector('tr'),['售后单号','操作'])`);
 try{
  assert.equal(read(),undefined);
  d.window.document.querySelector('span').setAttribute('ipc_info',JSON.stringify({biz_id:85110001,has_ipc_video:true}));
  assert.equal(read(),'available');
  d.window.document.querySelector('span').setAttribute('ipc_info',JSON.stringify({biz_id:85110001,has_ipc_video:false}));
  assert.equal(read(),undefined);
 }finally{d.window.close();}
});
