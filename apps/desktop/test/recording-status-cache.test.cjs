const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRecordingStatusCache}=require('../src/recording-status-cache.cjs');

test('confirmed absence remains visible after freshness expiry, but cannot bypass a new check',()=>{
 let time=1000;
 const cache=createRecordingStatusCache(()=>time);
 const identity={sourceCompany:'A',afterSaleId:'85110001'};
 cache.record([{...identity,recordingStatus:'unavailable'}]);
 time+=30000;
 assert.equal(cache.get(identity).state,'unavailable');
 assert.equal(cache.get(identity,true),undefined);
 cache.record([{...identity}]);
 assert.equal(cache.get(identity).state,'unavailable');
 cache.record([{...identity,recordingStatus:'available'}]);
 assert.equal(cache.get(identity,true).state,'available');
 assert.equal(cache.get({...identity,sourceCompany:'B'}),undefined);
 cache.clear();assert.equal(cache.get(identity),undefined);
});
