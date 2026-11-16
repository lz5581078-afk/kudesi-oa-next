'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {executeOrderRemark,readOrderRemark}=require('../src/jushuitan-order-remark.cjs');
function fixture({original='旧备注',company='来源公司',claim=true,persist=true,duplicate=false,blank=false}={}){
 const dom=new JSDOM('',{runScripts:'outside-only'}),w=dom.window;
 w.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 let saved=original,submits=0,reloads=0,destroyed=false;
 const task={afterSaleId:'85118801',internalOrderId:'44008801',sourceCompany:'来源公司',expected:'旧备注',remark:'新备注\n第二行'};
 const calls=[];
 const frame={url:'https://src.erp321.com/afterSales',executeJavaScript:async code=>w.eval(code)};
 const target={isDestroyed:()=>destroyed,destroy:()=>{destroyed=true;w.close();}};
 const locate=async(_,identity,reload)=>{
  assert.equal(identity.internalOrderId,task.internalOrderId);if(reload)reloads++;
  w.document.body.innerHTML='<div class="ant-modal-content"><div class="ant-modal-title">编辑卖家备注/旗帜</div><textarea></textarea><input type="radio" value="3" checked><button>保 存</button></div>';
  w.document.querySelector('textarea').value=blank?'':saved;
  if(blank)w.document.querySelector('input').checked=false;
  w.document.querySelector('button').onclick=()=>{submits++;if(persist)saved=w.document.querySelector('textarea').value;w.document.body.innerHTML='';};
  if(duplicate)w.document.body.append(w.document.body.firstChild.cloneNode(true));
  return {frame,original:{remark:saved}};
 };
 const responses=async(url,options)=>{
  const phase=new URL(url).pathname.split('/').at(-1),body=JSON.parse(options.body);calls.push({phase,body});
  return {ok:phase!=='begin'||claim,json:async()=>phase==='prepare'?task:phase==='begin'?{started:true}:{id:1,status:body.result==='succeeded'?'done':'failed',remark:task.remark}};
 };
 return {task,calls,responses,submits:()=>submits,reloads:()=>reloads,destroyed:()=>destroyed,
  options:{origin:'https://oa.example.test',input:{id:1,permit:'a'.repeat(64)},open:async()=>target,company:async()=>company,locate}};
}
test('read-only client returns exact identity and original remark without save',async()=>{
 const f=fixture();const result=await readOrderRemark({...f.options,input:f.task});
 assert.equal(result.remark,'旧备注');assert.equal(result.flag,'3');assert.equal(f.submits(),0);assert.equal(f.destroyed(),true);
});
test('save is submitted once and confirmed only by a fresh navigation and readback',async t=>{
 const f=fixture();t.mock.method(globalThis,'fetch',f.responses);
 const result=await executeOrderRemark(f.options);assert.equal(result.status,'done');assert.equal(f.submits(),1);assert.equal(f.reloads(),1);assert.equal(f.destroyed(),true);
 assert.deepEqual(f.calls.map(c=>c.phase),['prepare','begin','result']);assert.equal(f.calls.at(-1).body.observed,'新备注\n第二行');
});
test('concurrent remark change never submits or claims',async t=>{
 const f=fixture({original:'别人刚修改'});t.mock.method(globalThis,'fetch',f.responses);
 await assert.rejects(executeOrderRemark(f.options),/已变化/);assert.equal(f.submits(),0);assert.equal(f.calls.at(-1).body.submitted,false);
});
test('company mismatch never opens or submits the editor',async t=>{
 const f=fixture({company:'另一公司'});t.mock.method(globalThis,'fetch',f.responses);
 await assert.rejects(executeOrderRemark(f.options),/不一致/);assert.equal(f.submits(),0);
});
test('paused or already claimed task never submits',async t=>{
 const f=fixture({claim:false});t.mock.method(globalThis,'fetch',f.responses);
 await assert.rejects(executeOrderRemark(f.options),/无法领取/);assert.equal(f.submits(),0);
});
test('a filled textbox without persisted data is uncertain and never retried',async t=>{
 const f=fixture({persist:false});t.mock.method(globalThis,'fetch',f.responses);
 await assert.rejects(executeOrderRemark(f.options),/回读不一致/);assert.equal(f.submits(),1);assert.equal(f.calls.at(-1).body.result,'unknown');
});
test('lost receipt acknowledgement retries only OA receipt, never ERP save',async t=>{
 const f=fixture();let count=0;t.mock.method(globalThis,'fetch',async(...args)=>{if(String(args[0]).endsWith('/result')&&count++===0)throw Error('offline');return f.responses(...args);});
 assert.equal((await executeOrderRemark(f.options)).status,'done');assert.equal(f.submits(),1);
});
test('actual ERP blank means unchanged: read original from the row and preserve unselected flags',async t=>{
 const f=fixture({blank:true});t.mock.method(globalThis,'fetch',f.responses);
 assert.equal((await executeOrderRemark(f.options)).status,'done');assert.equal(f.submits(),1);
});
test('row remark extraction preserves line breaks and excludes the edit control',()=>{
 const {locateJushuitanField}=require('../src/jushuitan-source-field.cjs');
 const dom=new JSDOM('<table><thead><tr><th>售后单号</th><th>原订单备注/旗帜</th></tr></thead><tbody><tr><td>85118801</td><td>完整第一行<br>第二行<button>编辑</button><svg>红旗</svg></td></tr></tbody></table>',{runScripts:'outside-only'});
 dom.window.HTMLElement.prototype.getClientRects=()=>[{}];
 const read=dom.window.eval('('+locateJushuitanField.toString()+')');
 assert.equal(read('85118801','原订单备注/旗帜',false,'read').remark,'完整第一行\n第二行');dom.window.close();
});
