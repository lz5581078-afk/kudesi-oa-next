'use strict';

async function withCollectionDeadline(operation,ms,onTimeout,message){
 let timer;
 try{
  return await Promise.race([
   Promise.resolve().then(operation),
   new Promise((_,reject)=>{timer=setTimeout(()=>{
    try{onTimeout();}catch(cause){reject(new Error(message,{cause}));return;}
    reject(new Error(message));
   },ms);}),
  ]);
 }finally{clearTimeout(timer);}
}

module.exports={withCollectionDeadline};
