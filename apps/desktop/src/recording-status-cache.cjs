'use strict';

function createRecordingStatusCache(now=Date.now){
 const entries=new Map();
 const key=({sourceCompany,afterSaleId})=>JSON.stringify([sourceCompany,afterSaleId]);
 return {
  record(records){
   const checkedAt=now();
   for(const record of records){
    if(!['available','unavailable'].includes(record.recordingStatus))continue;
    const identity=key(record);
    entries.delete(identity);
    entries.set(identity,{state:record.recordingStatus,checkedAt,
     expiresAt:checkedAt+(record.recordingStatus==='unavailable'?15000:60000)});
   }
   while(entries.size>1200)entries.delete(entries.keys().next().value);
  },
  get(identity,freshOnly=false){
   const entry=entries.get(key(identity));
   // Expiry requires rechecking before playback; it must not erase a confirmed
   // "no recording" badge merely because the OA list polled again.
   return entry&&(!freshOnly||entry.expiresAt>now())?entry:undefined;
  },
  clear(){entries.clear();},
 };
}
module.exports={createRecordingStatusCache};
