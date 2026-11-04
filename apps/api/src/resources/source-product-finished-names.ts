import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import {createHash} from 'crypto';
import {createChecker,type ResourceFormInput} from '@kudesi/shared';
import {EntityManager} from 'typeorm';
import {Company,ResourceRecord} from '../entities';
import type {AuthUser} from '../common/auth.decorators';
import type {BeforeSaveContext} from './resource-rules';
import {aliasCode,rawNames} from './base-code-support';
import {basicInfoFullName} from './product-extras';
import {loadUnitLists} from './unit-options';
import {recordVersion} from './resource-record-version';
export const SOURCE_FINISHED_NAMES_COMMAND='__sourceFinishedNames';
export interface SourceFinishedNameRow{name:string;rowToken:string;aliasRecordId?:number;version?:string}
export interface SourceFinishedNamesCommand{version:1;expected:Array<{aliasRecordId:number;version:string}>;rows:SourceFinishedNameRow[]}
export interface SourceFinishedAliasPlan{name:string;key:string;code:string;rowToken:string;fullName:string;existing:ResourceRecord|null}
interface Scope{companyId:number;userId:number;productId:number|null;rows:SourceFinishedNameRow[];initial:Map<number,ResourceRecord>;materialized:Map<string,number>;plans:Map<string,SourceFinishedAliasPlan>;completed:boolean;write?:{plan:SourceFinishedAliasPlan;canonicalId:number;productId:number}}
const scopes=new WeakMap<EntityManager,Scope>();
const text=(v:unknown)=>typeof v==='string'?v:'';
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const version=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{16}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const owns=(s:Scope|undefined,u:AuthUser)=>s?.companyId===u.companyId&&s.userId===u.id;
const matches=(r:ResourceRecord,pid:number,name:string,companyId:number)=>r.data.productId===pid&&(r.data.migratedAliasName===name||r.data.aliasKey===aliasCode(companyId,pid,name));
/** Original source contract uses String(company), String(product), stable UUID, not the alias name. */
export const sourceFinishedNameCode=(companyId:number,productId:number,rowToken:string)=>`YL-${createHash('sha256').update(JSON.stringify([String(companyId),String(productId),rowToken])).digest('hex').slice(0,20).toUpperCase()}`;

export async function beginSourceFinishedNameForm({em,user,existing,input}:{em:EntityManager;user:AuthUser;existing:ResourceRecord|null;input?:ResourceFormInput}){
 scopes.delete(em);const raw=input?.values[SOURCE_FINISHED_NAMES_COMMAND];if(raw===undefined)return;
 if(!input||!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('原料成品名操作参数无效');
 const cmd=raw as Record<string,unknown>;
 if(Object.keys(cmd).some(k=>!['version','expected','rows'].includes(k))||cmd.version!==1||!Array.isArray(cmd.rows)||cmd.rows.length>100||!Array.isArray(cmd.expected)||cmd.expected.length>100)throw new BadRequestException('原料成品名操作范围无效');
 if((input.values.archiveType??existing?.data.archiveType)!=='raw'||existing&&existing.type!=='finance-products')throw new BadRequestException('只有原料档案可维护成品名身份');
 const can=createChecker(user.permissions);if(!can(existing?'resource.finance-products.edit':'resource.finance-products.create'))throw new ForbiddenException('没有维护原料成品名的权限');
 const rows:SourceFinishedNameRow[]=[],names=new Set<string>(),tokens=new Set<string>(),ids=new Set<number>();
 for(const rawRow of cmd.rows){
  if(!rawRow||typeof rawRow!=='object'||Array.isArray(rawRow))throw new BadRequestException('原料成品名行无效');const r=rawRow as Record<string,unknown>;
  if(Object.keys(r).some(k=>!['name','rowToken','aliasRecordId','version'].includes(k))||typeof r.name!=='string'||!r.name.trim()||r.name!==r.name.trim()||r.name.length>160)throw new BadRequestException('原料成品名须填写1至160个字符');
  const norm=r.name.normalize('NFKC').replace(/\s+/g,'').toLowerCase();if(names.has(norm))throw new BadRequestException('同一原料的成品名不能重复');names.add(norm);
  if(!uuid(r.rowToken)||tokens.has(r.rowToken.toLowerCase()))throw new BadRequestException('原料成品名标识无效或重复');tokens.add(r.rowToken.toLowerCase());
  if(r.aliasRecordId!==undefined){if(!positive(r.aliasRecordId)||ids.has(r.aliasRecordId)||!version(r.version)||!existing||input.copySource)throw new BadRequestException('原料成品名身份或版本无效');ids.add(r.aliasRecordId);}
  else if(r.version!==undefined)throw new BadRequestException('新增成品名不能携带已有版本');
  rows.push({name:r.name,rowToken:r.rowToken, ...(r.aliasRecordId!==undefined?{aliasRecordId:r.aliasRecordId as number,version:r.version as string}:{})});
 }
 if(typeof input.values.rawFinishedNames!=='string'||input.values.rawFinishedNames!==rows.map(r=>r.name).join('\n'))throw new BadRequestException('原料成品名列表与身份列表不一致');
 const expected=new Map<number,string>();
 for(const rawExpected of cmd.expected){if(!rawExpected||typeof rawExpected!=='object'||Array.isArray(rawExpected))throw new BadRequestException('成品名版本快照无效');const e=rawExpected as Record<string,unknown>;if(Object.keys(e).some(k=>!['aliasRecordId','version'].includes(k))||!positive(e.aliasRecordId)||!version(e.version)||expected.has(e.aliasRecordId))throw new BadRequestException('成品名版本快照无效');expected.set(e.aliasRecordId,e.version);}
 if((!existing||input.copySource)&&expected.size)throw new BadRequestException('新增或复制不能携带其他档案的成品名身份');
 await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
 const all=existing?await em.createQueryBuilder(ResourceRecord,'a').where('a.companyId=:companyId AND a.type=:type',{companyId:user.companyId,type:'finance-base-codes'}).andWhere("JSON_EXTRACT(a.data,'$.productId')=:pid",{pid:existing.id}).orderBy('a.id','ASC').setLock('pessimistic_write').getMany():[];
 const available=all.filter(r=>!r.archivedAt&&r.status!=='deleted'),roots=new Map(available.filter(r=>!positive(r.data.canonicalId)).map(r=>[r.id,r]));
 const aliases=available.filter(r=>positive(r.data.canonicalId)&&roots.get(r.data.canonicalId)?.data.productId===existing?.id);
 const initial=new Map<number,ResourceRecord>();
 for(const name of existing?rawNames(existing.data.rawFinishedNames):[]){const found=aliases.filter(r=>matches(r,existing!.id,name,user.companyId));if(found.length>1)throw new ConflictException('成品名关联不唯一，请重新核对基础编码');if(found.length===1)initial.set(found[0].id,found[0]);}
 if(expected.size!==initial.size||[...initial].some(([rid,r])=>expected.get(rid)!==recordVersion(r)))throw new ConflictException('成品名资料刚被修改，请重新打开档案');
 for(const row of rows){
  if(row.aliasRecordId!==undefined){const r=initial.get(row.aliasRecordId);if(!r||row.version!==recordVersion(r))throw new ConflictException('成品名不属于当前档案或版本已变化');const bound=text(r.data.sourceFinishedRowToken);if(bound&&bound!==row.rowToken)throw new ConflictException('成品名稳定标识已变化，请重新打开档案');}
  else if(existing&&[...initial.values()].some(r=>matches(r,existing.id,row.name,user.companyId)))throw new ConflictException('已有成品名必须携带实际身份，请重新打开档案');
 }
 if(tokens.size){const used=await em.createQueryBuilder(ResourceRecord,'a').select('a.id','id').addSelect("JSON_EXTRACT(a.data,'$.sourceFinishedRowToken')",'token').where('a.companyId=:companyId AND a.type=:type',{companyId:user.companyId,type:'finance-base-codes'}).andWhere("LOWER(JSON_UNQUOTE(JSON_EXTRACT(a.data,'$.sourceFinishedRowToken'))) IN (:...tokens)",{tokens:[...tokens]}).setLock('pessimistic_write').getRawMany<{id:number;token:unknown}>();for(const found of used){const row=rows.find(r=>r.rowToken.toLowerCase()===text(found.token).toLowerCase());if(!row||row.aliasRecordId!==found.id)throw new ConflictException('成品名标识已使用，请重新添加');}}
 delete input.values[SOURCE_FINISHED_NAMES_COMMAND];scopes.set(em,{companyId:user.companyId,userId:user.id,productId:existing?.id??null,rows,initial,materialized:new Map(),plans:new Map(),completed:rows.length===0});
}

export async function sourceFinishedAliasPlans(em:EntityManager,user:AuthUser,product:ResourceRecord,real:ResourceRecord,aliases:ResourceRecord[]):Promise<Map<string,SourceFinishedAliasPlan>>{
 const scope=scopes.get(em),trusted=owns(scope,user)&&(!scope!.productId||scope!.productId===product.id),names=rawNames(product.data.rawFinishedNames),out=new Map<string,SourceFinishedAliasPlan>();
 if(trusted){if(product.companyId!==user.companyId||product.data.archiveType!=='raw'||names.join('\n')!==scope!.rows.map(r=>r.name).join('\n'))throw new ConflictException('原料成品名保存范围发生变化');scope!.productId=product.id;}
 const units=trusted||aliases.some(r=>r.data.sourceFinishedRowToken)?await loadUnitLists(em,user.companyId):undefined;
 for(const name of names){
  const requested=trusted?scope!.rows.find(r=>r.name===name):undefined,key=aliasCode(user.companyId,product.id,name);
  const requestedId=requested?(requested.aliasRecordId??scope!.materialized.get(requested.rowToken)):undefined;
  const candidates=requested?(requestedId?aliases.filter(r=>r.id===requestedId):[]):aliases.filter(r=>r.data.aliasKey===key);
  if(candidates.length>1&&(requested||candidates.some(r=>r.data.sourceFinishedRowToken)))throw new ConflictException('成品名关联不唯一，请核对基础编码');
  const existing=candidates[0]??null,token=requested?.rowToken||text(existing?.data.sourceFinishedRowToken);if(!token)continue;
  if(requested?.aliasRecordId&&(!existing||existing.data.canonicalId!==real.id||existing.data.productId!==product.id))throw new ConflictException('成品名实际归属已变化');
  const code=existing?text(existing.data.code):sourceFinishedNameCode(user.companyId,product.id,token);if(!code)throw new ConflictException('成品名实际编码缺失');
  out.set(name,{name,key,code,rowToken:token,fullName:basicInfoFullName({...product.data,name},'',units).slice(0,200),existing});
 }
 if(trusted){scope!.plans=out;scope!.completed=true;}return out;
}
export async function withSourceFinishedAliasWrite(em:EntityManager,user:AuthUser,productId:number,canonicalId:number,plan:SourceFinishedAliasPlan,write:()=>Promise<ResourceRecord>):Promise<ResourceRecord>{
 const scope=scopes.get(em);if(!owns(scope,user)||scope!.productId!==productId||scope!.plans.get(plan.name)!==plan)throw new ForbiddenException('成品名身份只允许原料表单内部维护');const previous=scope!.write;scope!.write={plan,canonicalId,productId};try{const record=await write();scope!.materialized.set(plan.rowToken,record.id);return record;}finally{scope!.write=previous;}
}
/** A short-lived exact write authority; never a client or queryRunner flag. */
export function trustedSourceFinishedAlias(ctx:BeforeSaveContext,productId:number,canonicalId:number):{aliasKey:string;rowToken:string}|null{
 const scope=scopes.get(ctx.em),write=scope?.write;if(!owns(scope,ctx.user)||!write||write.productId!==productId||write.canonicalId!==canonicalId||write.plan.code!==ctx.data.code||write.plan.existing?.id!==ctx.existing?.id)return null;
 return {aliasKey:write.plan.key,rowToken:write.plan.rowToken};
}
export function finishSourceFinishedNameForm(em:EntityManager,user:AuthUser){const scope=scopes.get(em);if(owns(scope,user)&&!scope!.completed)throw new ConflictException('成品名基础编码尚未建立，请刷新后重试');}
export function endSourceFinishedNameForm(em:EntityManager){scopes.delete(em);}

export function assertSourceFinishedProductInput(ctx:BeforeSaveContext){
 if(ctx.input&&Object.prototype.hasOwnProperty.call(ctx.input,SOURCE_FINISHED_NAMES_COMMAND)){const scope=scopes.get(ctx.em);if(!owns(scope,ctx.user)||scope!.productId!==(ctx.existing?.id??null))throw new BadRequestException('成品名身份只允许原料整组表单提交');}
 if(ctx.input&&Object.prototype.hasOwnProperty.call(ctx.input,'sourceFinishedRowToken'))throw new BadRequestException('不能手工写入成品名稳定标识');
}
