const {test}=require('node:test'),assert=require('node:assert/strict');
const {createRequestWatch}=require('../src/request-watch.cjs');
test('request proof distinguishes completion, failure and other clients without inspecting credentials or data',()=>{
 const listeners={},session={webRequest:{onBeforeRequest:cb=>listeners.before=cb,onCompleted:cb=>listeners.done=cb,onErrorOccurred:cb=>listeners.error=cb}};
 const controls=createRequestWatch(session),a=controls.forContents(1),b=controls.forContents(2);a.arm();b.arm();
 const request=(id,webContentsId)=>{const d={id,webContentsId,resourceType:'xhr'};for(const key of ['url','requestHeaders','uploadData'])Object.defineProperty(d,key,{get:()=>{throw new Error('Credentials and data must never be read');}});listeners.before(d,()=>{});};
 request(10,1);request(11,2);assert.equal(a.state().pending,1);assert.equal(b.state().pending,1);
 listeners.done({id:10,statusCode:200});assert.equal(a.state().completed,1);assert.equal(a.state().failed,0);assert.equal(b.state().pending,1);
 listeners.error({id:11});assert.equal(b.state().failed,1);assert.equal(b.state().pending,0);
 a.arm();request(12,1);listeners.done({id:12,statusCode:503});assert.equal(a.state().failed,1);
 a.stop();request(13,1);assert.equal(a.state(),null);
});
