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
function runDom(html,url){const dom=new JSDOM(html,{url,runScripts:'outside-only'});Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});dom.window.HTMLElement.prototype.getClientRects=function(){return this.hidden?[]:[{}];};return dom.window.eval(`(${extractVisible.toString()})()`);}
test('extract list by headers, exclude hidden rows and page credentials',()=>{
 const r=runDom(`<p>演示公司 [客服]</p><div>password=do-not-save</div><table><thead><tr><th>售后单号</th><th>内部订单号</th><th>商品信息</th><th>线上状态</th><th>操作</th></tr></thead><tbody><tr><td>售后单号：851139355</td><td>4450075</td><td>演示种子 1袋</td><td>等待确认收货</td><td>秘密操作</td></tr><tr hidden><td>851139356</td><td>4450076</td><td>x</td><td>x</td><td>x</td></tr></tbody></table>`,'https://innerorder.scm121.com/afterSales');
 // jsdom has no innerText; use browser-compatible getter in fixture below.
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].afterSaleId,'851139355');assert.equal(r.rows[0].internalOrderId,'4450075');assert.equal(r.rows[0].fields['线上状态'],'等待确认收货');assert.equal(JSON.stringify(r).includes('do-not-save'),false);
});
test('merge detail only with matching internal order, preserve multiple after-sales',()=>{
 const result=mergeFrames([{sourceCompany:'示例公司',rows:[{afterSaleId:'85110000',internalOrderId:'4400000',fields:{线上状态:'待退货'}}],detail:[]},{sourceCompany:'',rows:[],detail:[{afterSaleId:'85110000',internalOrderId:'9900000',fields:{售后日志:'另一订单'}},{afterSaleId:'85110001',internalOrderId:'4400000',fields:{售后分类:'退货'}}]}]);
 assert.equal(result.length,2);assert.equal(result[0].internalOrderId,'4400000');assert.equal(result[0].fields['售后日志'],undefined);assert.equal(result[1].sourceCompany,'示例公司');
});
test('nested detail keeps after-sales separated and reads totals, logistics and logs',()=>{
 const r=runDom(`<pre>订单编号：4400001\n买家留言：(无)\n实际已付：54.29\n快递公司：演示快递\n售后单号：85110001\n申请金额：54.29\n退回快递单号：DEMO111\n售后单号：85110002\n申请金额：30.00\n退回快递单号：DEMO222\n订单操作进程及日志\n2026-11-04 接单</pre>`,'https://erp321.com/app/order/order/OrderEditorNew.aspx?jmxToken=never-persist');
 assert.equal(r.detail.length,2);assert.equal(r.detail[0].internalOrderId,'4400001');assert.equal(r.detail[0].fields['线上申请金额'],'54.29');assert.equal(r.detail[1].fields['线上申请金额'],'30.00');assert.equal(r.detail[0].fields['退货快递单号'],'DEMO111');assert.equal(r.detail[1].fields['退货快递单号'],'DEMO222');assert.equal(r.detail[0].fields['实际已付'],'54.29');assert.match(r.detail[0].fields['订单操作日志'],/接单/);assert.equal(JSON.stringify(r).includes('never-persist'),false);
});
test('internal-order opener cannot click another numeric business action',()=>{
 const {openVisibleOrder}=require('../src/extractor.cjs');
 const dom=new JSDOM('<button id="refund">4400001</button><table><thead><tr><th>内部订单号</th><th>操作</th></tr></thead><tbody><tr><td><button id="order">4400001</button></td><td><button id="other">9900001</button></td></tr></tbody></table>',{runScripts:'outside-only'});
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});dom.window.HTMLElement.prototype.getClientRects=()=>[{}];let order=0,other=0;dom.window.document.getElementById('order').onclick=()=>order++;dom.window.document.getElementById('other').onclick=()=>other++;dom.window.document.getElementById('refund').onclick=()=>other++;
 assert.equal(dom.window.eval(`(${openVisibleOrder.toString()})('4400001')`),true);assert.equal(order,1);assert.equal(other,0);assert.equal(dom.window.eval(`(${openVisibleOrder.toString()})('9900001')`),false);assert.equal(other,0);
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
test('each archived source field can be captured from its visible list column',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const shared=fs.readFileSync(path.join(__dirname,'../../../packages/shared/src/desktop-after-sales.ts'),'utf8');
 const block=shared.match(/export const AFTER_SALES_FIELDS = \[(.*?)\] as const;/)[1];
 const fields=[...block.matchAll(/'([^']+)'/g)].map(m=>m[1]);
 const r=runDom(`<table><thead><tr><th>售后单号</th><th>内部订单号</th>${fields.map(f=>`<th>${f}</th>`).join('')}</tr></thead><tbody><tr><td>85110001</td><td>4400001</td>${fields.map((_,i)=>`<td>字段 ${i}</td>`).join('')}</tr></tbody></table>`,'https://erp321.com/epaas');
 assert.deepEqual(Object.keys(r.rows[0].fields),fields);
 assert.equal(r.rows[0].fields[fields.at(-1)],`字段 ${fields.length-1}`);
});
test('list aliases, icon labels and hidden field cells are handled without reading image URLs',()=>{
 const r=runDom('<table><thead><tr><th>售后单号</th><th>内部订单号</th><th>申请日期</th><th>买家图片凭证</th><th>卖家退款账号</th></tr></thead><tbody><tr><td>85110001</td><td>4400001</td><td>2026-11-06 10:00:00</td><td><img alt="买家凭证" src="https://example.test/private"></td><td hidden>不读取</td></tr></tbody></table>','https://erp321.com/epaas');
 assert.deepEqual({...r.rows[0].fields},{申请时间:'2026-11-06 10:00:00',买家图片凭证:'买家凭证'});
});
