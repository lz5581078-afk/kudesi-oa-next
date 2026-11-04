import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import {createChecker,type ResourceFormInput,validUnitCents} from '@kudesi/shared';
import type {EntityManager} from 'typeorm';
import type {AuthUser} from '../common/auth.decorators';
import {ResourceRecord} from '../entities';
import type {BeforeSaveContext} from './resource-rules';
import {recordVersion} from './resource-record-version';
export const SOURCE_IMPORTED_LABOR_COPY='__sourceImportedLaborCopy';
interface Scope{companyId:number;userId:number;sourceId:number;parentId:number|null;rows:Map<number,ResourceRecord>;used:Set<number>}
const scopes=new WeakMap<EntityManager,Scope>();
export async function beginSourceBomCopy({em,user,existing,input}:{em:EntityManager;user:AuthUser;existing:ResourceRecord|null;input?:ResourceFormInput}){
 const commands=(input?.collections??[]).flatMap(collection=>collection.rows.filter(row=>row.values[SOURCE_IMPORTED_LABOR_COPY]!==undefined).map(row=>({type:collection.type,row})));
 if(!commands.length)return;
 if(existing||!input?.copySource||commands.some(({type,row})=>type!=='finance-product-boms'||!!row.id))throw new BadRequestException('原文件人工复制必须从实际商品档案复制入口提交');
 if(!createChecker(user.permissions)('product.cost.edit'))throw new ForbiddenException('复制原文件人工成本需要成本维护权限');
 const source=await em.findOne(ResourceRecord,{where:{id:input.copySource.id,companyId:user.companyId,type:'finance-products'},lock:{mode:'pessimistic_write'}});
 if(!source||source.archivedAt||source.status==='deleted'||recordVersion(source)!==input.copySource.version)throw new ConflictException('复制来源刚被修改或删除，请重新打开');
 if(source.data.archiveType!=='self_made'||input.values.archiveType!=='self_made')throw new BadRequestException('原文件人工只能随同源自产成品复制');
 const expected=new Map<number,string>();
 for(const {row}of commands){const raw=row.values[SOURCE_IMPORTED_LABOR_COPY];if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('人工复制来源无效');const command=raw as Record<string,unknown>;if(Object.keys(command).some(key=>!['rowId','version'].includes(key))||!Number.isSafeInteger(command.rowId)||Number(command.rowId)<1||typeof command.version!=='string'||!command.version||expected.has(Number(command.rowId)))throw new BadRequestException('人工复制来源重复或不完整');expected.set(Number(command.rowId),command.version);}
 let locked:ResourceRecord[];
 try{locked=await em.createQueryBuilder(ResourceRecord,'bom').where('bom.companyId=:company AND bom.type=:type AND bom.id IN (:...ids)',{company:user.companyId,type:'finance-product-boms',ids:[...expected.keys()]}).orderBy('bom.id','ASC').setLock('pessimistic_write').setOnLocked('nowait').getMany();}catch(error){if((error as {driverError?:{code?:string}}).driverError?.code==='ER_LOCK_NOWAIT'||(error as {code?:string}).code==='ER_LOCK_NOWAIT')throw new ConflictException('来源组成正在修改，请刷新后重试');throw error;}
 if(locked.length!==expected.size||locked.some(row=>row.archivedAt||row.status!=='active'||row.data.productId!==source.id||row.data.importLineKind!=='labor'||recordVersion(row)!==expected.get(row.id)||!String(row.data.importLaborName||'').trim()||!validUnitCents(row.data.importLaborCost)||Number(row.data.importLaborCost)<0))throw new ConflictException('原文件人工来源已变化或不属于复制的档案');
 scopes.set(em,{companyId:user.companyId,userId:user.id,sourceId:source.id,parentId:null,rows:new Map(locked.map(row=>[row.id,row])),used:new Set()});
}
export function bindSourceBomCopy(em:EntityManager,user:AuthUser,record:ResourceRecord,existing:ResourceRecord|null){const scope=scopes.get(em);if(scope&&scope.companyId===user.companyId&&scope.userId===user.id&&!existing&&scope.parentId===null&&record.id!==scope.sourceId)scope.parentId=record.id;}
export function applySourceBomCopy(ctx:BeforeSaveContext){const raw=ctx.input?.[SOURCE_IMPORTED_LABOR_COPY];if(raw===undefined)return false;const scope=scopes.get(ctx.em);if(!scope||scope.companyId!==ctx.user.companyId||scope.userId!==ctx.user.id||ctx.existing||scope.parentId!==ctx.data.productId)throw new BadRequestException('人工复制缺少可信商品来源');const command=raw as {rowId?:unknown;version?:unknown},source=scope.rows.get(Number(command.rowId));if(!source||recordVersion(source)!==command.version||scope.used.has(source.id))throw new ConflictException('人工复制来源已变化或重复');ctx.data.importLineKind='labor';ctx.data.importLaborName=source.data.importLaborName;ctx.data.importLaborCost=source.data.importLaborCost;ctx.data.componentId=undefined;ctx.data.laborId=undefined;delete ctx.data[SOURCE_IMPORTED_LABOR_COPY];scope.used.add(source.id);return true;}
export function finishSourceBomCopy(em:EntityManager,user:AuthUser){const scope=scopes.get(em);try{if(scope&&(scope.companyId!==user.companyId||scope.userId!==user.id||scope.parentId===null||scope.used.size!==scope.rows.size))throw new BadRequestException('原文件人工复制未完整保存');}finally{scopes.delete(em);}}
