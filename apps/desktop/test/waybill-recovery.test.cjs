'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {executeWaybillRecovery,isRecoveryHomeFrame,recoveryRows} = require('../src/jushuitan-waybill-recovery.cjs');

const good='YT12345678901';
const bad='JT12345678902';
const home='https://src.erp321.com/erp-web-group/home/?epaas=true#/erp-home';

test('only the exact ERP homepage frame may run recovery',()=>{
  assert.equal(isRecoveryHomeFrame(home),true);
  assert.equal(isRecoveryHomeFrame('https://src.erp321.com.evil.test/erp-web-group/home/#/erp-home'),false);
  assert.equal(isRecoveryHomeFrame('https://src.erp321.com/erp-web-group/after-sales/#/erp-home'),false);
});

test('a mixed result with an absent number cannot identify which other number succeeded',()=>{
  const result=recoveryRows([good,bad,'YT12345678903'],{
    success:1,failedCount:1,missing:1,failed:[{number:bad,message:'已发货'}],
  });
  assert.deepEqual(result.map(row=>row.status),['unknown','failed','unknown']);
  assert.equal(result[1].message,'已发货');
  assert.deepEqual(recoveryRows([good],{success:0,failedCount:0,missing:1,failed:[]}),
    [{number:good,status:'failed',message:'聚水潭未找到这个运单号'}]);
});

function fixture({option='不区分平台', sourceCompany='来源公司', claimed=true, delayed=false, icon=false, duplicate=false}={}) {
  const dom=new JSDOM('<button id="open">单号回收</button>',{runScripts:'outside-only'});
  const w=dom.window;
  const entry=w.document.getElementById('open');
  if(icon) entry.innerHTML='<svg aria-hidden="true"></svg>单号回收';
  if(duplicate) w.document.body.insertAdjacentHTML('beforeend','<a>单号回收</a>');
  if(delayed) {
    entry.hidden=true;
    setTimeout(()=>{entry.hidden=false;},450);
  }
  w.HTMLElement.prototype.getClientRects=function(){
    return this.closest('[hidden]')?[]:[{}];
  };
  let submits=0;
  w.document.getElementById('open').onclick=()=>{
    w.document.body.insertAdjacentHTML('beforeend',
      '<div role="dialog"><div class="ant-modal-title">单号回收</div>'+
      '<div class="ant-select"><div class="ant-select-selector"><input id="LIdType">'+
      '<span class="ant-select-selection-item"></span></div></div>'+
      '<textarea id="WayBillCodes"></textarea>'+
      '<label><input type="checkbox">忽略订单状态强制回收</label>'+
      '<button id="confirm">确 认</button></div>');
    const selectors=w.document.querySelector('.ant-select-selector');
    selectors.addEventListener('mousedown',()=>{
      w.document.body.insertAdjacentHTML('beforeend','<div role="option">'+option+'</div>');
      w.document.querySelector('[role="option"]').onclick=()=>{
        w.document.querySelector('.ant-select-selection-item').textContent=option;
        w.document.querySelector('[role="option"]').remove();
      };
      w.document.getElementById('LIdType').setAttribute('aria-expanded','true');
    },{once:true});
    w.document.getElementById('confirm').onclick=()=>{
      assert.equal(w.document.querySelector('textarea').value,good+'\n'+bad);
      assert.equal(w.document.querySelector('input[type="checkbox"]').checked,true);
      assert.equal(w.document.querySelector('.ant-select-selection-item').textContent,'不区分平台');
      submits++;
      w.document.body.insertAdjacentHTML('beforeend','<div role="dialog">'+
        '<div class="ant-modal-title">单号回收结果</div>回收成功1,回收失败1,不存在0'+
        '<table><tbody><tr><td>'+bad+'</td><td>已发货</td></tr></tbody></table></div>');
    };
  };
  const frame={url:home,executeJavaScript:async script=>w.eval(script)};
  const calls=[];
  const responses=async (url,opts)=>{
    const action=url.pathname.split('/').at(-1);
    const data=JSON.parse(opts.body);
    calls.push({action,data});
    return {ok:action!=='begin'||claimed,json:async()=>action==='prepare'?
      {sourceCompany:'来源公司',numbers:[good,bad]}:action==='begin'?{started:true}:data.rows};
  };
  return {calls,responses,submits:()=>submits,options:{
    origin:'https://oa.example.test',input:{id:15,permit:'a'.repeat(64)},
    open:async()=>({webContents:{mainFrame:{framesInSubtree:[frame]}},isDestroyed:()=>false,destroy:()=>w.close()}),
    company:async()=>sourceCompany,
  }};
}

test('desktop submits the exact two numbers and reports each result to OA',async t=>{
  const f=fixture();
  t.mock.method(globalThis,'fetch',f.responses);
  const rows=await executeWaybillRecovery(f.options);
  assert.equal(f.submits(),1);
  assert.deepEqual(f.calls.map(call=>call.action),['prepare','begin','result']);
  assert.equal(f.calls[2].data.submitted,true);
  assert.deepEqual(rows,[{number:good,status:'succeeded'},{number:bad,status:'failed',message:'已发货'}]);
});

test('waits for the menu rendered after its iframe exists',async t=>{
  const f=fixture({delayed:true});
  t.mock.method(globalThis,'fetch',f.responses);
  await executeWaybillRecovery(f.options);
  assert.equal(f.submits(),1);
  assert.deepEqual(f.calls.map(call=>call.action),['prepare','begin','result']);
});

test('finds a unique exact menu label with a decorative child icon',async t=>{
  const f=fixture({icon:true});
  t.mock.method(globalThis,'fetch',f.responses);
  await executeWaybillRecovery(f.options);
  assert.equal(f.submits(),1);
});

test('distinct duplicate visible entries fail before claiming or submitting',async t=>{
  const f=fixture({duplicate:true});
  t.mock.method(globalThis,'fetch',f.responses);
  await assert.rejects(executeWaybillRecovery(f.options),/多个单号回收入口/);
  assert.equal(f.submits(),0);
  assert.deepEqual(f.calls.map(call=>call.action),['prepare','result']);
  assert.equal(f.calls.at(-1).data.submitted,false);
});

test('OA claim rejection leaves the ERP form unsubmitted',async t=>{
  const f=fixture({claimed:false});
  t.mock.method(globalThis,'fetch',f.responses);
  await assert.rejects(executeWaybillRecovery(f.options),/未能领取/);
  assert.equal(f.submits(),0);
  assert.equal(f.calls.at(-1).data.submitted,false);
});

test('desktop rejects a different signed-in company before touching the form',async t=>{
  const f=fixture({sourceCompany:'另一家公司'});
  t.mock.method(globalThis,'fetch',f.responses);
  await assert.rejects(executeWaybillRecovery(f.options),/来源不一致/);
  assert.equal(f.submits(),0);
  assert.deepEqual(f.calls.map(call=>call.action),['prepare','result']);
});

test('a different platform option is never submitted', async t => {
  const f = fixture({option:'淘宝'});
  t.mock.method(globalThis, 'fetch', f.responses);
  await assert.rejects(executeWaybillRecovery(f.options), /未提供「不区分平台」/);
  assert.equal(f.submits(), 0);
  assert.deepEqual(f.calls.map(call => call.action), ['prepare', 'result']);
  assert.equal(f.calls.at(-1).data.submitted, false);
});
