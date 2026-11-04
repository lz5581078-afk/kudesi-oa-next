/** 纯缓存层不依赖组件或AuthContext，身份切换可先失效目录再发布新用户。 */
export interface ReferenceOption {value:number;label:string;disabled?:boolean;leaf?:boolean;archiveType?:string;importArchiveType?:string}
export type ReferenceOptions=ReferenceOption[]&{total?:number};
interface Identity {id:number;companyId:number;permissions:{isCompanyAdmin?:boolean;allow?:readonly string[];deny?:readonly string[]}}
export const referenceIdentity=(user:Identity|null|undefined)=>JSON.stringify([user?.companyId,user?.id,!!user?.permissions?.isCompanyAdmin,[...(user?.permissions?.allow??[])].sort(),[...(user?.permissions?.deny??[])].sort()]);
let identity=referenceIdentity(null),version=0;
const listeners=new Set<()=>void>(),cache=new Map<string,{target:string;promise:Promise<ReferenceOptions>}>();
export const referenceCacheVersion=()=>version;
export const referenceCacheIdentity=()=>identity;
export const subscribeReferenceCache=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export function clearReferenceCache(target?:string){
  for(const [key,entry]of cache)if(!target||entry.target===target)cache.delete(key);
  version++;listeners.forEach(listener=>listener());
}
export function setReferenceCacheIdentity(user:Identity|null,force=false){
  const next=referenceIdentity(user),changed=force||identity!==next;if(changed){identity=next;clearReferenceCache();}return changed;
}
export function cachedReferenceOptions(target:string,scope:string,load:(current:()=>boolean)=>Promise<ReferenceOptions>):Promise<ReferenceOptions>{
  const key=JSON.stringify([identity,scope,target]),cached=cache.get(key);if(cached)return cached.promise;
  const revision=version,owner=identity;
  const promise=load(()=>identity===owner&&version===revision);cache.set(key,{target,promise});
  void promise.catch(()=>{if(cache.get(key)?.promise===promise)cache.delete(key);});
  return promise;
}
