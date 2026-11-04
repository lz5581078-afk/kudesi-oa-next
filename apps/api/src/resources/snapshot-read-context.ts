import type {EntityManager} from 'typeorm';
import {ResourceRecord} from '../entities';
import {loadUnitLists,type UnitLists} from './unit-options';

/** A single read batch, bound to the caller's actual manager and company. Never retained globally. */
export interface SnapshotReadContext {
 assertScope(manager:EntityManager,companyId:number):void;
 one(type:string,id:unknown):Promise<ResourceRecord|null>;
 byField(type:string,field:string,value:number):Promise<ResourceRecord[]>;
 all(type:string):Promise<ResourceRecord[]>;
 units():Promise<UnitLists>;
}
export interface SnapshotReadFieldRows {type:string;field:string;value:number;rows:ResourceRecord[]}
export function snapshotReadContext(em:EntityManager,companyId:number,seed:readonly ResourceRecord[]=[],seedFields:readonly SnapshotReadFieldRows[]=[]):SnapshotReadContext {
 const records=new Map<string,Promise<ResourceRecord|null>>(),fields=new Map<string,Promise<ResourceRecord[]>>(),catalogs=new Map<string,Promise<ResourceRecord[]>>();let units:Promise<UnitLists>|undefined;
 const recordKey=(type:string,id:number)=>JSON.stringify([type,id]);
 for(const row of seed)if(row.companyId===companyId)records.set(recordKey(row.type,row.id),Promise.resolve(row));
 for(const field of seedFields)fields.set(JSON.stringify([field.type,field.field,field.value]),Promise.resolve(field.rows.filter(row=>row.companyId===companyId&&row.type===field.type&&String(row.data[field.field])===String(field.value))));
 return {
  assertScope(manager,scopeCompanyId){if(manager!==em||scopeCompanyId!==companyId)throw new Error('快照读取上下文不匹配');},
  one(type,id){if(typeof id!=='number')return Promise.resolve(null);const key=recordKey(type,id);let value=records.get(key);if(!value){value=em.findOne(ResourceRecord,{where:{companyId,type,id}});records.set(key,value);}return value;},
  byField(type,field,value){const key=JSON.stringify([type,field,value]);let rows=fields.get(key);if(!rows){if(!/^[A-Za-z][A-Za-z0-9]*$/.test(field))throw new Error('快照引用字段无效');rows=em.createQueryBuilder(ResourceRecord,'r').where('r.companyId = :companyId AND r.type = :type',{companyId,type}).andWhere(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${field}')) = :v`,{v:String(value)}).getMany();fields.set(key,rows);}return rows;},
  all(type){let rows=catalogs.get(type);if(!rows){rows=em.find(ResourceRecord,{where:{companyId,type}}).then(found=>{for(const row of found)records.set(recordKey(type,row.id),Promise.resolve(row));return found;});catalogs.set(type,rows);}return rows;},
  units(){return units??=loadUnitLists(em,companyId);},
 };
}
