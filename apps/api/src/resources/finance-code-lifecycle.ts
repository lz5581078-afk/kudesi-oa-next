import { createChecker } from '@kudesi/shared';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { Company, ResourceRecord } from '../entities';
import { buildSnapshot, sigOf } from './base-code-support';
import type { BeforeSaveContext } from './resource-rules';
const activations=new WeakMap<EntityManager,Set<string>>();
const PHASES=['pending','verified','reverify'] as const;
export type CodePhase=typeof PHASES[number];
export const isCodeResource=(type:string)=>['finance-base-codes','finance-bundles'].includes(type);
export const inactiveCodeStatus=(type:string)=>type==='finance-base-codes'?'disabled':'inactive';
export function codeVerificationState(record:Pick<ResourceRecord,'type'|'status'|'data'>):CodePhase|null {
 if(!isCodeResource(record.type))return null;
 if((PHASES as readonly string[]).includes(record.status))return record.status as CodePhase;
 return record.status===inactiveCodeStatus(record.type) && (PHASES as readonly unknown[]).includes(record.data.verificationState) ? record.data.verificationState as CodePhase:null;
}
export function codeEnabledState(record:Pick<ResourceRecord,'type'|'status'>):'active'|'inactive'|null {
 return (PHASES as readonly string[]).includes(record.status)?'active':record.status===inactiveCodeStatus(record.type)?'inactive':null;
}
export function codeVerificationSignature(record:Pick<ResourceRecord,'data'>):string|undefined {
 try{return typeof record.data.snapshot==='string'?sigOf(JSON.stringify(JSON.parse(record.data.snapshot))):undefined;}catch{return undefined;}
}
type BundleSnapshot=(em:EntityManager,companyId:number,data:Record<string,unknown>,lines:Record<string,unknown>[])=>Promise<string>;
async function unchangedSnapshot(type:string,em:EntityManager,user:AuthUser,record:ResourceRecord,bundleSnapshot:BundleSnapshot):Promise<boolean> {
 if(typeof record.data.snapshot!=='string'||!record.data.snapshot)return false;
 try {
  const previous=JSON.stringify(JSON.parse(record.data.snapshot));
  if(type==='finance-base-codes'){const current=await buildSnapshot(em,user.companyId,record);return !current.issues.length&&JSON.stringify(current.snapshot)===previous;}
  const lines=await em.createQueryBuilder(ResourceRecord,'l').where('l.companyId=:companyId AND l.type=:type',{companyId:user.companyId,type:'finance-bundle-lines'}).andWhere("JSON_EXTRACT(l.data, '$.bundleId') = :id",{id:record.id}).orderBy('l.id','ASC').getMany();
  return JSON.stringify(JSON.parse(await bundleSnapshot(em,user.companyId,record.data,lines.map(line=>line.data))))===previous;
 } catch { return false; }
}
/** 仅代码资源启用这项状态解析；未知旧停用只在本次明确启用时建立新的待验证事实。 */
export async function resolveCodeStatus(type:string,ctx:{em:EntityManager;user:AuthUser;id:number;status:string},bundleSnapshot:BundleSnapshot) {
 if(!isCodeResource(type))return null;
 const {em,user}=ctx;
 if(!await em.findOne(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}}))throw new NotFoundException('记录不存在');
 const record=await em.findOne(ResourceRecord,{where:{id:ctx.id,type,companyId:user.companyId},lock:{mode:'pessimistic_write'}});
 if(!record)throw new NotFoundException('记录不存在');
 let status=ctx.status;
 if(status==='active'||record.status===inactiveCodeStatus(type)&&(PHASES as readonly string[]).includes(status)){
  if(record.status!==inactiveCodeStatus(type))status=record.status;
  else {const phase=codeVerificationState(record);status=phase==='verified'?(await unchangedSnapshot(type,em,user,record,bundleSnapshot)?'verified':'reverify'):phase??'pending';}
 }
 if((ctx.status==='active'||ctx.status===inactiveCodeStatus(type)||record.status===inactiveCodeStatus(type))&&status!==record.status&&!createChecker(user.permissions)(`resource.${type}.disable`))throw new ForbiddenException('没有改状态的权限');
 if(record.status===inactiveCodeStatus(type)&&(PHASES as readonly string[]).includes(status)){const set=activations.get(em)??new Set<string>();set.add(type+':'+record.id);activations.set(em,set);}
 return {record,status};
}
/** 标准保存仍走原有验证/引用规则；该内部字段不在字段定义中，不能导入或由客户端写入。 */
export async function finishCodeLifecycleSave(type:string,ctx:BeforeSaveContext,bundleSnapshot:BundleSnapshot) {
 if(!isCodeResource(type))return;
 if((PHASES as readonly string[]).includes(ctx.status)){
  if(ctx.existing?.status===inactiveCodeStatus(type)){const key=type+':'+ctx.existing.id;if(!activations.get(ctx.em)?.delete(key))throw new ForbiddenException('请先启用商品资料，再执行验证动作');}
  ctx.data.verificationState=ctx.status;return;
 }
 if(ctx.status!==inactiveCodeStatus(type))return;
 const phase=ctx.existing?codeVerificationState(ctx.existing):'pending';
 if(!phase){delete ctx.data.verificationState;return;}
 const candidate=Object.assign(new ResourceRecord(),ctx.existing,{type,data:ctx.data});
 ctx.data.verificationState=phase==='verified'&&!await unchangedSnapshot(type,ctx.em,ctx.user,candidate,bundleSnapshot)?'reverify':phase;
}
/** 内部二次验证联动保留停用状态；不因源档案变化重新启用。 */
export function directCodeStatus(type:string,record:ResourceRecord,status:string):string {
 if(!isCodeResource(type))return status;
 const phase=codeVerificationState(record);
 if(status===inactiveCodeStatus(type)){if(phase)record.data={...record.data,verificationState:phase};return status;}
 if(status==='reverify'&&record.status===inactiveCodeStatus(type)){
  if(phase==='verified')record.data={...record.data,verificationState:'reverify'};
  return record.status;
 }
 if((PHASES as readonly string[]).includes(status))record.data={...record.data,verificationState:status};
 return status;
}

export function codeVerificationSql(type:string) {
 const value="JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.verificationState'))";
 return `CASE WHEN r.status IN ('pending','verified','reverify') THEN r.status WHEN r.status='${inactiveCodeStatus(type)}' AND ${value} IN ('pending','verified','reverify') THEN ${value} ELSE NULL END`;
}
export function codeLifecycleCounts(records:ResourceRecord[],hiddenVerified=new Set<number>()) {
 const verification:Record<string,number>={},byEnabledState:Record<string,Record<string,number>>={active:{},inactive:{}};
 const byCodeLifecycleCategory:Record<string,Record<string,Record<string,number>>>={},byArchiveLifecycleCategory:Record<string,Record<string,Record<string,number>>>={};
 const byBundleLifecycleCategory:Record<string,Record<string,Record<string,number>>>={};
 let unknownInactive=0;
 for(const record of records){
  const phase=codeVerificationState(record),enabled=codeEnabledState(record);
  if(enabled==='inactive'&&!phase)unknownInactive++;
  if(!phase||!enabled||phase==='verified'&&hiddenVerified.has(record.id))continue;
  verification[phase]=(verification[phase]??0)+1;byEnabledState[enabled][phase]=(byEnabledState[enabled][phase]??0)+1;
  for(const [out,key]of [[byCodeLifecycleCategory,'codeDictionaryCategoryId'],[byArchiveLifecycleCategory,'categoryId'],[byBundleLifecycleCategory,'bundleCategoryId']] as const){
   const id=String(record.data[key]??0);out[id]??={};out[id][phase]??={};out[id][phase][enabled]=(out[id][phase][enabled]??0)+1;
  }
 }
 return {verification,byEnabledState,byCodeLifecycleCategory,byArchiveLifecycleCategory,byBundleLifecycleCategory,unknownInactive};
}
