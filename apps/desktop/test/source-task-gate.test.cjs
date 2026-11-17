'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {assertDedicatedTaskAvailable}=require('../src/source-task-gate.cjs');

test('dedicated recovery can start while the shared source window is reading the original order',()=>{
 assert.doesNotThrow(()=>assertDedicatedTaskAvailable({sharedWindowBusy:true,writeRunning:false,clearingSource:false}));
});

test('dedicated tasks cannot overlap a save/recovery or start while login is being cleared',()=>{
 assert.throws(()=>assertDedicatedTaskAvailable({writeRunning:true,clearingSource:false}),/等待当前任务完成/);
 assert.throws(()=>assertDedicatedTaskAvailable({writeRunning:false,clearingSource:true}),/清理聚水潭登录/);
});
