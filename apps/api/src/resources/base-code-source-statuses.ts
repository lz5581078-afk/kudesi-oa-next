import {EntityManager} from 'typeorm';
import {ResourceRecord} from '../entities';

type BaseRecord=Pick<ResourceRecord,'id'|'companyId'|'type'>;
interface SourceLink {id:number;productId:unknown;canonicalId:unknown;origin:unknown;canonicalProductId:unknown;canonicalParentId:unknown;canonicalOrigin:unknown}
const id=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
/** Actual single-product provenance only. A missing product is unknown, never inferred to have been deleted. */
export async function deriveBaseCodeSourceStatuses(em:EntityManager,companyId:number,records:readonly BaseRecord[]):Promise<Map<number,string|null>>{
 const candidates=records.filter(record=>record.type==='finance-base-codes'&&id(record.id));
 const result=new Map<number,string|null>(candidates.map(record=>[record.id,null]));
 const ids=[...new Set(candidates.filter(record=>record.companyId===companyId).map(record=>record.id))];
 if(!ids.length)return result;
 const links=await em.createQueryBuilder(ResourceRecord,'b').select('b.id','id')
  .addSelect("JSON_EXTRACT(b.data,'$.productId')",'productId').addSelect("JSON_EXTRACT(b.data,'$.canonicalId')",'canonicalId').addSelect("JSON_EXTRACT(b.data,'$.origin')",'origin')
  .leftJoin(ResourceRecord,'canonical',"canonical.companyId=b.companyId AND canonical.type=:baseType AND canonical.id=JSON_EXTRACT(b.data,'$.canonicalId')",{baseType:'finance-base-codes'})
  .addSelect("JSON_EXTRACT(canonical.data,'$.productId')",'canonicalProductId').addSelect("JSON_EXTRACT(canonical.data,'$.canonicalId')",'canonicalParentId').addSelect("JSON_EXTRACT(canonical.data,'$.origin')",'canonicalOrigin')
  .where('b.companyId=:companyId AND b.type=:type AND b.id IN (:...ids)',{companyId,type:'finance-base-codes',ids}).getRawMany<SourceLink>();
 const sources=new Map<number,number>();
 for(const link of links){
  const alias=link.canonicalId!==null&&link.canonicalId!==undefined;
  if(alias){
   // Alias provenance is the real root, and a conflicting local product ID is not authoritative.
   if(!id(link.canonicalId)||!id(link.canonicalProductId)||link.canonicalParentId!=null||['composed','external_import'].includes(String(link.canonicalOrigin))||link.productId!=null&&link.productId!==link.canonicalProductId)continue;
   sources.set(link.id,link.canonicalProductId);
  }else if(id(link.productId)&&!['composed','external_import'].includes(String(link.origin)))sources.set(link.id,link.productId);
 }
 if(!sources.size)return result;
 const products=await em.createQueryBuilder(ResourceRecord,'p').select('p.id','id').addSelect('p.status','status').addSelect('p.archivedAt','archivedAt')
  .where('p.companyId=:companyId AND p.type=:type AND p.id IN (:...ids)',{companyId,type:'finance-products',ids:[...new Set(sources.values())]}).getRawMany<{id:number;status:string;archivedAt:Date|string|null}>();
 const statuses=new Map(products.map(product=>[product.id,product.status==='deleted'?'deleted':product.archivedAt?null:product.status==='inactive'?'inactive':['active','normal'].includes(product.status)?'active':null]));
 for(const [baseId,productId]of sources)result.set(baseId,statuses.get(productId)??null);
 return result;
}
