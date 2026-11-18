'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {withCollectionDeadline}=require('../src/collection-deadline.cjs');

test('后台查询挂起时触发一次窗口重建，迟到结果不会恢复旧任务',async()=>{
 let recoveries=0,reply;
 const pending=withCollectionDeadline(()=>new Promise(resolve=>{reply=resolve;}),10,()=>{recoveries++;},'后台读取超时');
 await assert.rejects(pending,/后台读取超时/);
 reply('late');
 assert.equal(recoveries,1);
 const next=await withCollectionDeadline(()=>Promise.resolve('next'),100,()=>{recoveries++;},'后台读取超时');
 assert.equal(next,'next');
 assert.equal(recoveries,1);
});
