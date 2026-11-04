import {BadRequestException, ForbiddenException} from '@nestjs/common';
import {archiveQualityContext,archiveQualityFields,archiveQualityFingerprint,archiveQualityIssues,createChecker,mergeQualityReasons,validSourceQualityConfirmation,sourcePriceTime,
  type ResourceFormInput,type SourceQualityCommand,type SourceQualityComposition,type SourceQualityConfirmations,type SourceQualityFacts} from '@kudesi/shared';
import type {EntityManager} from 'typeorm';
import type {AuthUser} from '../common/auth.decorators';
import {ResourceRecord} from '../entities';
import {isWarehouseMode} from './warehouse-mode';

export const SOURCE_QUALITY_COMMAND='__sourceQuality';
export const SOURCE_QUALITY_CONFIRMATIONS='sourceQualityConfirmations';
interface Scope {companyId:number;userId:number;parentId:number|null;command:SourceQualityCommand;old?:SourceQualityFacts;oldConfirmations:SourceQualityConfirmations;bindings:Map<string,string>;seen:Set<string>;copy:boolean}
const scopes=new WeakMap<EntityManager,Scope>();
const id=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const text=(value:unknown)=>String(value??'').trim();
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function receipts(value:unknown):SourceQualityConfirmations {
 const out:SourceQualityConfirmations={};if(!plain(value))return out;
 for(const [key,row]of Object.entries(value))if(plain(row)&&typeof row.reason==='string'&&typeof row.context==='string')out[key]={reason:row.reason,context:row.context};
 return out;
}
function parseCommand(value:unknown,input:ResourceFormInput):SourceQualityCommand {
 if(!plain(value)||Object.keys(value).some(key=>!['version','rows','confirmations'].includes(key))||value.version!==1||!Array.isArray(value.rows)||value.rows.length>4000||!plain(value.confirmations)||Object.keys(value.confirmations).length>8000)throw new BadRequestException('核算资料确认命令无效');
 const keys=new Set<string>(),positions=new Set<string>();
 for(const row of value.rows){
  if(!plain(row)||Object.keys(row).some(key=>!['type','index','key','id'].includes(key))||!['finance-product-sources','finance-product-boms'].includes(String(row.type))||!Number.isSafeInteger(row.index)||Number(row.index)<0||typeof row.key!=='string')throw new BadRequestException('核算资料行绑定无效');
  const collection=input.collections.find(collection=>collection.type===row.type),actual=collection?.rows[Number(row.index)];
  const position=`${row.type}:${row.index}`;
  if(!actual||actual.id!==row.id||(row.id!==undefined&&!id(row.id))||keys.has(row.key)||positions.has(position))throw new BadRequestException('核算资料行绑定重复或不属于实际提交资料');
  if(row.id!==undefined?row.key!==`id:${row.id}`:! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.key))throw new BadRequestException('核算资料行标识无效');
  keys.add(row.key);positions.add(position);
 }
 for(const collection of input.collections.filter(collection=>['finance-product-sources','finance-product-boms'].includes(collection.type)))for(let index=0;index<collection.rows.length;index++)if(!positions.has(`${collection.type}:${index}`))throw new BadRequestException('核算资料行绑定不完整');
 for(const [key,row] of Object.entries(value.confirmations))if(!key||key.length>180||!plain(row)||Object.keys(row).some(key=>!['reason','context'].includes(key))||typeof row.reason!=='string'||!row.reason.trim()||row.reason.trim().length>180||typeof row.context!=='string'||row.context.length>200000)throw new BadRequestException('核算资料确认原因或上下文无效');
 return value as unknown as SourceQualityCommand;
}
/** Only this exact same-manager Source form scope may defer intermediate legacy zero checks. */
export function sourceProductQualityActive(em:EntityManager,user:AuthUser):boolean {const scope=scopes.get(em);return scope?.companyId===user.companyId&&scope.userId===user.id;}
export function sourceQualityValues(values:Record<string,unknown>):Record<string,unknown>{const out={...values};delete out[SOURCE_QUALITY_COMMAND];return out;}
export function endSourceProductQuality(em:EntityManager):void {scopes.delete(em);}

/** Actual DB facts, not a client projection; never return this through ordinary DTOs. */
export async function loadSourceProductQualityFacts(em:EntityManager,companyId:number,record:ResourceRecord):Promise<SourceQualityFacts>{
 if(record.companyId!==companyId||record.type!=='finance-products')throw new BadRequestException('核算资料档案归属无效');
 const rows=await em.createQueryBuilder(ResourceRecord,'row').where('row.companyId=:companyId AND row.type IN (:...types)',{companyId,types:['finance-product-sources','finance-product-boms']}).andWhere("JSON_EXTRACT(row.data, '$.productId') = :parentId",{parentId:record.id}).andWhere('row.archivedAt IS NULL').orderBy('row.id','ASC').getMany();
 const boms=rows.filter(row=>row.type==='finance-product-boms'&&row.status==='active');
 const refs=new Map<string,Promise<ResourceRecord|null>>();
 const read=(type:string,value:unknown)=>{if(!id(value))return Promise.resolve(null);const key=`${type}:${value}`;let pending=refs.get(key);if(!pending){pending=em.findOne(ResourceRecord,{where:{id:value,type,companyId}});refs.set(key,pending);}return pending;};
 const composition:SourceQualityComposition[]=await Promise.all(boms.map(async row=>{
  const d=row.data,component=await read('finance-products',d.componentId),labor=await read('finance-labor-costs',d.laborId);
  const imported=d.importLineKind==='labor'&&!id(d.componentId)&&!id(d.laborId)&&!!text(d.importLaborName);
  const unit=labor&&id(labor.data.unitId)?await read('finance-labor-units',labor.data.unitId):null;
  const kind=component?(['raw','package','oem_package'].includes(String(component.data.archiveType))?component.data.archiveType as 'raw'|'package'|'oem_package':'unknown'):labor?'labor':imported?'imported_labor':'unknown';
  return {key:`id:${row.id}`,id:row.id,kind,referenceId:component?.id??labor?.id??null,qty:d.qty,lossPercent:d.lossPercent,
   unit:component?component.data.specUnit:unit?.data.name??labor?.data.unitName??'',...(imported?{importedLaborName:d.importLaborName}:{})};
 }));
 return {version:1,productId:record.id,parent:{...record.data},sources:rows.filter(row=>row.type==='finance-product-sources').map(row=>({key:`id:${row.id}`,id:row.id,status:row.status,supplierId:row.data.supplierId,originArea:row.data.originArea,systemSpec:row.data.systemSpec,purchasePrice:row.data.purchasePrice})),composition};
}
export async function beginSourceProductQuality({em,user,existing,input}:{em:EntityManager;user:AuthUser;existing:ResourceRecord|null;input?:ResourceFormInput}):Promise<void>{
 const raw=input?.values[SOURCE_QUALITY_COMMAND];if(raw===undefined)return;
 if(scopes.has(em)||!input)throw new BadRequestException('核算资料确认作用域重复');
 const command=parseCommand(raw,input);
 const old=existing?await loadSourceProductQualityFacts(em,user.companyId,existing):undefined;
 scopes.set(em,{companyId:user.companyId,userId:user.id,parentId:existing?.id??null,command,old,oldConfirmations:receipts(existing?.data[SOURCE_QUALITY_CONFIRMATIONS]),bindings:new Map(),seen:new Set(),copy:!!input.copySource});
}
export function sourceQualitySavedRows(em:EntityManager,parent:ResourceRecord,child:{key:string},rows:Array<{index:number;record:ResourceRecord}>):void {
 const scope=scopes.get(em);if(!scope||!['finance-product-sources','finance-product-boms'].includes(child.key))return;
 if(parent.companyId!==scope.companyId||parent.type!=='finance-products'||scope.parentId!==null&&scope.parentId!==parent.id)throw new BadRequestException('核算资料保存归属无效');
 scope.parentId=parent.id;
 for(const {index,record}of rows){const binding=scope.command.rows.find(row=>row.type===child.key&&row.index===index);
  if(!binding||record.companyId!==scope.companyId||record.type!==child.key||record.data.productId!==parent.id||binding.id!==undefined&&binding.id!==record.id||scope.seen.has(`${child.key}:${index}`))throw new BadRequestException('核算资料保存行与草稿不一致');
  scope.seen.add(`${child.key}:${index}`);scope.bindings.set(`id:${record.id}`,binding.key);
 }
}
function draftFacts(facts:SourceQualityFacts,bindings:Map<string,string>):SourceQualityFacts{return {...facts,sources:facts.sources.map(row=>({...row,key:bindings.get(row.key)??row.key})),composition:facts.composition.map(row=>({...row,key:bindings.get(row.key)??row.key}))};}
export async function finishSourceProductQuality(em:EntityManager,user:AuthUser,record:ResourceRecord):Promise<void>{
 const scope=scopes.get(em);if(!scope)return;
 if(!sourceProductQualityActive(em,user)||record.companyId!==scope.companyId||scope.parentId!==null&&scope.parentId!==record.id||scope.seen.size!==scope.command.rows.length)throw new BadRequestException('核算资料确认尚未完整保存');
 const fresh=await em.findOne(ResourceRecord,{where:{id:record.id,companyId:user.companyId,type:'finance-products'}});
 if(!fresh)throw new BadRequestException('核算资料档案不存在');
 const actual=await loadSourceProductQualityFacts(em,user.companyId,fresh),draft=draftFacts(actual,scope.bindings);
 const warehouse=await isWarehouseMode(em,user),can=createChecker(user.permissions),hidden=warehouse||!can('product.cost.view');
 const confirmations:SourceQualityConfirmations={...scope.command.confirmations};
 if(hidden&&scope.old&&!scope.copy){const context=archiveQualityContext(actual);for(const [key,receipt]of Object.entries(scope.oldConfirmations))if(receipt.context===context&&confirmations[key]===undefined)confirmations[key]=receipt;}
 // Exact old/new equality is the sole Source legacy exemption. Never re-sign old text as confirmation.
 const priorContext=scope.old?archiveQualityContext(scope.old):'';
 const priorStillValid=Object.values(scope.oldConfirmations).every(receipt=>validSourceQualityConfirmation(receipt,priorContext));
 if(scope.old&&!scope.copy&&priorStillValid&&archiveQualityFingerprint(scope.old,scope.oldConfirmations)===archiveQualityFingerprint(actual,confirmations))return;
 const issues=archiveQualityIssues(actual.parent,{canCost:true,sourceFacts:draft,confirmations});
 if(issues.length)throw new BadRequestException(`核算资料尚未完成：${issues.map(issue=>issue.message).join('；')}`);
 const context=archiveQualityContext(actual),draftContext=archiveQualityContext(draft),saved:SourceQualityConfirmations={};
 const fields=archiveQualityFields(actual.parent,{canCost:true,sourceFacts:actual});
 for(const field of fields.filter(field=>field.value!==null&&field.value!==undefined&&text(field.value)!==''&&Number(field.value)===0&&field.mode!=='positive'&&field.mode!=='text')){
  let submittedId=field.id;for(const [actualKey,draftKey]of scope.bindings)if(field.id.startsWith(`source:${actualKey}:`))submittedId=field.id.replace(`source:${actualKey}:`,`source:${draftKey}:`);
  const receipt=confirmations[submittedId];if(!receipt||receipt.context!==draftContext)throw new BadRequestException('核算资料确认已失效');
  if((hidden||!can('product.cost.edit'))&&(field.id==='purchasePrice'||field.id==='freight'||field.id==='handlingFee'||field.id.endsWith(':purchasePrice'))&&JSON.stringify(scope.oldConfirmations[field.id])!==JSON.stringify(receipt))throw new ForbiddenException('确认核算资料需要成本维护权限');
  saved[field.id]={reason:receipt.reason.trim(),context};
 }
 const legacy:Record<string,string>={};
 for(const field of fields)if(['freight','handlingFee','purchasePrice','weightG','packagingGroup','laborGroup'].includes(field.id)&&saved[field.id])legacy[field.label]=saved[field.id].reason;
 const zeroValueReason=mergeQualityReasons(fresh.data.zeroValueReason,legacy);
 if(zeroValueReason.length>2000)throw new BadRequestException('零值说明超过2000字，请精简原有说明后再保存');
 fresh.data={...fresh.data,zeroValueReason,[SOURCE_QUALITY_CONFIRMATIONS]:saved};await em.save(ResourceRecord,fresh);record.data=fresh.data;
}


/** 普通写只复用原本为零且仍被实际 Source 快照确认的旧值，不签发新确认。 */
export async function sourceQualityConfirmedLegacyZero(em:EntityManager,user:AuthUser,existing:ResourceRecord|null,proposedData:Record<string,unknown>,field:string):Promise<boolean>{
 if(!existing||existing.companyId!==user.companyId||existing.type!=='finance-products'||existing.data[field]!==0||proposedData[field]!==0||!['purchasePrice','freight','handlingFee','weightG'].includes(field))return false;
 const confirmed=receipts(existing.data[SOURCE_QUALITY_CONFIRMATIONS]);if(!Object.keys(confirmed).length)return false;
 const actual=await loadSourceProductQualityFacts(em,user.companyId,existing),proposed:SourceQualityFacts={...actual,parent:{...existing.data,...proposedData}};
 const context=archiveQualityContext(proposed);
 let key=field;
 if(field==='purchasePrice'&&['raw','shipping_material'].includes(String(existing.data.archiveType))){
  const rows=await em.createQueryBuilder(ResourceRecord,'source').where('source.companyId=:companyId AND source.type=:type AND source.status=:status',{companyId:user.companyId,type:'finance-product-sources',status:'active'}).andWhere("JSON_EXTRACT(source.data, '$.productId') = :productId",{productId:existing.id}).andWhere('source.archivedAt IS NULL').getMany();
  // Same price clock and legacy tie-break as refreshFromSources; never match by price/name.
  rows.sort((a,b)=>sourcePriceTime(b.data.priceUpdatedAt,b.updatedAt)-sourcePriceTime(a.data.priceUpdatedAt,a.updatedAt)||(a.data.legacySourceId&&b.data.legacySourceId?Number(BigInt(text(b.data.legacySourceId))-BigInt(text(a.data.legacySourceId))):b.id-a.id));
  const current=rows[0];if(!current||current.data.purchasePrice!==0||existing.data.supplierId!==current.data.supplierId)return false;
  key=`source:id:${current.id}:purchasePrice`;
 }
 return validSourceQualityConfirmation(confirmed[key],context);
}
