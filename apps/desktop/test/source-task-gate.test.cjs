'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {assertDedicatedTaskAvailable}=require('../src/source-task-gate.cjs');

for(const command of ['readOrderRemark','saveOrderRemark']){
 test(command+' uses its independent window while the shared query or mounted view is occupied',()=>{
  assert.doesNotThrow(()=>assertDedicatedTaskAvailable(command,{sharedWindowBusy:true,writeRunning:false,clearingSource:false}));
 });
 test(command+' cannot overlap an existing save/recovery or clear the login session',()=>{
  assert.throws(()=>assertDedicatedTaskAvailable(command,{sharedWindowBusy:false,writeRunning:true,clearingSource:false}),/等待当前任务完成/);
  assert.throws(()=>assertDedicatedTaskAvailable(command,{sharedWindowBusy:false,writeRunning:false,clearingSource:true}),/清理聚水潭登录/);
 });
}
test('waybill recovery keeps the original shared-window occupancy protection',()=>{
 assert.throws(()=>assertDedicatedTaskAvailable('recoverWaybills',{sharedWindowBusy:true,writeRunning:false,clearingSource:false}),/窗口正在使用/);
 assert.doesNotThrow(()=>assertDedicatedTaskAvailable('recoverWaybills',{sharedWindowBusy:false,writeRunning:false,clearingSource:false}));
});
