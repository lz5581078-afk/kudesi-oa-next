import {EntityManager} from 'typeorm';
import {ResourceRecord} from '../entities';
import {aliasCode,rawNames} from './base-code-support';
import {basicInfoFullName} from './product-extras';
import {recordVersion} from './resource-record-version';
import type {UnitLists} from './unit-options';
type Product=Pick<ResourceRecord,'id'|'companyId'|'type'|'data'>;
export interface ProductFinishedNameFact{name:string;code:string|null;fullName:string;aliasRecordId:number|null;version:string|null;rowToken:string|null}
const id=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?v:null;
const text=(v:unknown)=>typeof v==='string'?v:'';
/** Only display actual related base-code facts; alias identity and write lifecycle are unchanged. */
export async function deriveProductFinishedNames(em:EntityManager,companyId:number,records:readonly Product[]):Promise<Map<number,ProductFinishedNameFact[]>>{
 const products=records.filter(p=>p.companyId===companyId&&p.type==='finance-products'&&p.data.archiveType==='raw'&&id(p.id)!==null),result=new Map<number,ProductFinishedNameFact[]>();
 if(!products.length)return result;
 const rows=await em.createQueryBuilder(ResourceRecord,'b').select(['b.id','b.companyId','b.type','b.title','b.status','b.data','b.secrets','b.archivedAt','b.updatedAt'])
  .where('b.companyId=:companyId AND b.type=:type AND b.status<>:deleted AND b.archivedAt IS NULL',{companyId,type:'finance-base-codes',deleted:'deleted'})
  .andWhere("JSON_EXTRACT(b.data,'$.productId') IN (:...ids)",{ids:products.map(p=>p.id)}).getMany();
 const units:UnitLists=new Map();
 const unitRows=await em.createQueryBuilder(ResourceRecord,'u').select("JSON_EXTRACT(u.data,'$.kind')",'kind').addSelect("JSON_EXTRACT(u.data,'$.code')",'code').addSelect("JSON_EXTRACT(u.data,'$.name')",'name')
  .where('u.companyId=:companyId AND u.type=:type AND u.status<>:deleted AND u.archivedAt IS NULL',{companyId,type:'finance-product-units',deleted:'deleted'}).getRawMany<{kind:unknown;code:unknown;name:unknown}>();
 for(const u of unitRows){const kind=text(u.kind),list=units.get(kind)??[];list.push({code:text(u.code),name:text(u.name),active:true});units.set(kind,list);}
 const roots=new Map(rows.filter(r=>id(r.data.canonicalId)===null).map(r=>[r.id,r]));
 for(const product of products){
  const aliases=rows.filter(row=>row.data.productId===product.id&&id(row.data.canonicalId)!==null&&roots.get(id(row.data.canonicalId)!)?.data.productId===product.id);
  result.set(product.id,rawNames(product.data.rawFinishedNames).map(name=>{
   const candidates=aliases.filter(row=>text(row.data.migratedAliasName)===name||text(row.data.aliasKey)===aliasCode(companyId,product.id,name));
   const alias=candidates.length===1?candidates[0]:undefined;
   return {name,code:alias&&text(alias.data.code)?text(alias.data.code):null,fullName:basicInfoFullName({...product.data,name},'',units),aliasRecordId:alias?.id??null,version:alias?recordVersion(alias):null,rowToken:alias&&text(alias.data.sourceFinishedRowToken)?text(alias.data.sourceFinishedRowToken):null};
  }));
 }
 return result;
}
