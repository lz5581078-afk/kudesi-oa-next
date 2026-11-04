import {beforeEach,expect,it} from 'vitest';
import {cachedReferenceOptions,clearReferenceCache,referenceIdentity,setReferenceCacheIdentity,type ReferenceOptions} from './referenceOptionsCache';

const user=(companyId=1,id=1,allow:string[]=[])=>({companyId,id,permissions:{allow,deny:[]}});
beforeEach(()=>setReferenceCacheIdentity(null,true));
it('同身份复用目录；公司、人员、权限变化和退出均重新读取',async()=>{
 let reads=0;const load=async()=>[{value:++reads,label:`目录${reads}`}];
 for(const current of [user(),user(2),user(2,2),user(2,2,['product.cost.view']),null]){
  setReferenceCacheIdentity(current);const scope=referenceIdentity(current);
  const first=await cachedReferenceOptions('finance-categories',scope,load);
  expect(await cachedReferenceOptions('finance-categories',scope,load)).toBe(first);
 }
 expect(reads).toBe(5);
 expect(referenceIdentity(user(1,1,['a','b']))).toBe(referenceIdentity(user(1,1,['b','a'])));
});
it('旧请求失败不清除已失效后重读的请求；只清指定目录',async()=>{
 let reject!:(error:Error)=>void;
 const old=cachedReferenceOptions('user','',()=>new Promise<ReferenceOptions>((_,fail)=>{reject=fail;}));
 const other=await cachedReferenceOptions('department','',async()=>[{value:2,label:'部门'}]);
 clearReferenceCache('user');
 const fresh=await cachedReferenceOptions('user','',async()=>[{value:3,label:'当前员工'}]);
 reject(new Error('旧读取失败'));await expect(old).rejects.toThrow('旧读取失败');
 expect(await cachedReferenceOptions('user','',async()=>[])).toBe(fresh);
 expect(await cachedReferenceOptions('department','',async()=>[])).toBe(other);
});
