import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import {createChecker,type ResourceFormInput} from '@kudesi/shared';
import {EntityManager} from 'typeorm';
import {Company,ResourceRecord} from '../entities';
import type {AuthUser} from '../common/auth.decorators';
import type {BeforeSaveContext,RuleHost} from './resource-rules';

const TYPE='finance-product-units';
export const SOURCE_UNIT_COMMAND='__sourceUnitDefaults';
const nameUnits=Object.freeze([{name:'包',code:'B'},{name:'斤',code:'J'},{name:'袋',code:'D'},{name:'件',code:'PCS'},{name:'克',code:'G'},{name:'千克',code:'KG'}]);
/** 真24 createProductArchiveInitial三套各自的默认池；独立编码spec_unit不属于该初始化。 */
export const sourceUnitDefaults=(kind:string):readonly {name:string;code:string}[]=>['archive_unit','packaging_unit','shipping_unit'].includes(kind)?nameUnits:[];
interface Scope{companyId:number;userId:number;kind:string;action:'add'|'remove';removeCode?:string;anchorCode?:string;ready:boolean;seeding:boolean}
const unitScopes=new WeakMap<EntityManager,Scope>();
const productScopes=new WeakMap<EntityManager,{companyId:number;userId:number}>();
const owns=(scope:{companyId:number;userId:number}|undefined,user:AuthUser)=>scope?.companyId===user.companyId&&scope.userId===user.id;
export async function lockSourceUnitCompany(em:EntityManager,companyId:number){await em.findOneOrFail(Company,{where:{id:companyId},lock:{mode:'pessimistic_write'}});}
const kindRows=async(em:EntityManager,companyId:number,kind:string)=>await em.createQueryBuilder(ResourceRecord,'unit').where('unit.companyId=:companyId AND unit.type=:type',{companyId,type:TYPE}).andWhere("JSON_UNQUOTE(JSON_EXTRACT(unit.data,'$.kind'))=:kind",{kind}).orderBy('unit.id','ASC').setLock('pessimistic_write').getMany();
export function beginSourceProductForm(em:EntityManager,user:AuthUser,existing:ResourceRecord|null){if(!existing)productScopes.set(em,{companyId:user.companyId,userId:user.id});}
export function sourceProductFormKind(em:EntityManager,user:AuthUser,existing:ResourceRecord|null,copySource:ResourceRecord|undefined,archiveType:string):{apply:boolean;value:unknown}{
 if(existing||!owns(productScopes.get(em),user))return{apply:false,value:undefined};
 if(copySource)return{apply:true,value:copySource.data.unitDictionaryKind};
 if(!['raw','self_made','purchased','package','oem_package','shipping_material'].includes(archiveType))return{apply:false,value:undefined};
 return{apply:true,value:archiveType==='shipping_material'?'shipping_unit':'archive_unit'};
}

export function endSourceProductForm(em:EntityManager){productScopes.delete(em);}
export async function beginSourceUnitForm(ctx:{em:EntityManager;user:AuthUser;existing:ResourceRecord|null;input?:ResourceFormInput}){
 const input=ctx.input,command=input?.values[SOURCE_UNIT_COMMAND];if(command===undefined)return;
 if(!input||ctx.existing||input.id||input.copySource||input.collections.length||input.status&&input.status!=='active'||!command||typeof command!=='object'||Array.isArray(command))throw new BadRequestException('单位默认操作参数无效');
 const raw=command as Record<string,unknown>,kind=String(raw.kind||'');
 if(Object.keys(raw).some(key=>!['version','kind','action','code'].includes(key))||raw.version!==1||!['spec_unit','archive_unit','packaging_unit','shipping_unit'].includes(kind)||input.values.kind!==kind||!['add','remove'].includes(String(raw.action)))throw new BadRequestException('单位默认操作范围无效');
 const can=createChecker(ctx.user.permissions);if(!can('resource.finance-product-units.create')||raw.action==='remove'&&!can('resource.finance-product-units.delete'))throw new ForbiddenException('新增或删除默认单位的权限不足');
 const defaults=sourceUnitDefaults(kind),scope:Scope={companyId:ctx.user.companyId,userId:ctx.user.id,kind,action:raw.action as 'add'|'remove',ready:false,seeding:false};
 await lockSourceUnitCompany(ctx.em,ctx.user.companyId);
 if((await kindRows(ctx.em,ctx.user.companyId,kind)).length)throw new ConflictException('单位目录已变化，请刷新后再操作');
 if(scope.action==='remove'){
  if(typeof raw.code!=='string'||!defaults.some(unit=>unit.code===raw.code))throw new BadRequestException('只能删除当前源默认池中的单位');
  const anchor=defaults.find(unit=>unit.code!==raw.code);if(!anchor||input.values.name!==anchor.name||input.values.code!==anchor.code)throw new BadRequestException('保留的默认单位不匹配');
  scope.removeCode=raw.code;scope.anchorCode=anchor.code;input.values.sortOrder=defaults.indexOf(anchor);
 }else{
  if(raw.code!==undefined)throw new BadRequestException('新增单位不能携带删除命令');
  const name=String(input.values.name||'').normalize('NFKC').trim().replace(/\s+/g,' '),code=String(input.values.code||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase();
  if(defaults.some(unit=>unit.name===name||unit.code===code))throw new ConflictException('默认单位名称或编码已存在，不能覆盖');
  input.values.sortOrder=defaults.length;
 }
 delete input.values[SOURCE_UNIT_COMMAND];unitScopes.set(ctx.em,scope);
}
export async function materializeSourceUnits(ctx:BeforeSaveContext){
 const scope=unitScopes.get(ctx.em);if(!scope||!owns(scope,ctx.user)||scope.seeding||scope.ready)return;
 if(ctx.existing||ctx.data.kind!==scope.kind)throw new BadRequestException('单位默认操作不能更换归属');
 if((await kindRows(ctx.em,ctx.user.companyId,scope.kind)).length)throw new ConflictException('单位目录已变化，请刷新后再操作');
 scope.seeding=true;
 try{for(const [index,unit]of sourceUnitDefaults(scope.kind).entries())if(unit.code!==scope.anchorCode)await ctx.host.createRecord(ctx.em,ctx.user,TYPE,{kind:scope.kind,name:unit.name,code:unit.code,sortOrder:index},'按原档案单位显式操作初始化默认项');scope.ready=true;}finally{scope.seeding=false;}
}
export async function finishSourceUnitForm(ctx:{em:EntityManager;host:RuleHost;user:AuthUser;record:ResourceRecord}){
 const scope=unitScopes.get(ctx.em);if(!scope||!owns(scope,ctx.user))return;
 try{if(!scope.ready||ctx.record.data.kind!==scope.kind)throw new BadRequestException('单位默认操作没有完整保存');if(scope.action==='remove'){
  if(ctx.record.data.code!==scope.anchorCode)throw new BadRequestException('保留的默认单位已变化');
  const target=(await kindRows(ctx.em,ctx.user.companyId,scope.kind)).filter(row=>row.data.code===scope.removeCode&&row.status==='active'&&!row.archivedAt);
  if(target.length!==1)throw new ConflictException('要删除的默认单位已变化');
  await ctx.host.removeRecord(ctx.em,ctx.user,TYPE,target[0].id,'在原档案单位维护中删除默认单位',undefined,true);
 }}finally{unitScopes.delete(ctx.em);}
}
