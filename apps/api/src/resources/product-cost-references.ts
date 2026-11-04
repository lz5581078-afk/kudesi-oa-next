import {ConflictException} from '@nestjs/common';
import {In,Like,type EntityManager} from 'typeorm';
import {ResourceLink,ResourceRecord} from '../entities';

export const COST_SOURCE_BUCKETS=['purchase','transfer','pre_ship_package','production','shipping_package','express'] as const;
export type CostSourceBucket=typeof COST_SOURCE_BUCKETS[number];
export interface ArchiveCostReference{productId:number;archiveCostId:number}
export type CostBucketOrigins=Partial<Record<CostSourceBucket,ArchiveCostReference[]>>;
export interface CostSourceProvenance{version:1;archiveCosts:ArchiveCostReference[];buckets:CostBucketOrigins;complete:boolean}
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uniqueRefs=(rows:ArchiveCostReference[])=>[...new Map(rows.map(row=>[`${row.productId}:${row.archiveCostId}`,row])).values()].sort((a,b)=>a.productId-b.productId||a.archiveCostId-b.archiveCostId);
function refs(value:unknown):ArchiveCostReference[]|undefined{
 if(!Array.isArray(value)||value.some(row=>!object(row)||!positive(row.productId)||!positive(row.archiveCostId)))return undefined;
 return uniqueRefs(value.map(row=>({productId:row.productId as number,archiveCostId:row.archiveCostId as number})));
}
/** Internal origin facts. An absent bucket is unknown, not an asserted empty origin. */
export function readCostBucketOrigins(value:unknown):CostBucketOrigins|undefined{
 if(!object(value)||value.version!==1||!object(value.buckets))return undefined;const result:CostBucketOrigins={};
 for(const bucket of COST_SOURCE_BUCKETS)if(Object.hasOwn(value.buckets,bucket)){const rows=refs(value.buckets[bucket]);if(!rows)return undefined;result[bucket]=rows;}
 return result;
}
export function costSourceProvenance(buckets:CostBucketOrigins):CostSourceProvenance{
 return {version:1,archiveCosts:uniqueRefs(COST_SOURCE_BUCKETS.flatMap(bucket=>buckets[bucket]??[])),buckets,complete:COST_SOURCE_BUCKETS.every(bucket=>Object.hasOwn(buckets,bucket))};
}
export function readCostSourceProvenance(value:unknown):CostSourceProvenance|undefined{
 const buckets=readCostBucketOrigins(value);if(!buckets||!object(value))return undefined;const archiveCosts=refs(value.archiveCosts);if(!archiveCosts)return undefined;
 const calculated=costSourceProvenance(buckets);if(JSON.stringify(archiveCosts)!==JSON.stringify(calculated.archiveCosts)||value.complete!==calculated.complete)return undefined;return calculated;
}
/** Called by the canonical link rebuilder as well as the original activation transaction. */
export async function syncProductCostSnapshotReferences(em:EntityManager,companyId:number,record:ResourceRecord){
 if(record.companyId!==companyId||record.type!=='finance-cost-skus')return;
 const snapshot=object(record.data.snapshot)?record.data.snapshot:undefined,provenance=readCostSourceProvenance(snapshot?.sourceProvenance);
 if(object(snapshot?.sourceProvenance)&&snapshot.sourceProvenance.version===1&&!provenance)throw new ConflictException('成本来源快照格式不完整，不能重建引用');
 if(snapshot?.sourceProvenance&&!provenance)return;
 const sources=provenance?.archiveCosts??[],ids=[...new Set(sources.map(row=>row.archiveCostId))];
 const targets=ids.length?await em.find(ResourceRecord,{where:{companyId,type:'finance-product-costs',id:In(ids)}}):[];
 for(const source of sources)if(!targets.some(row=>row.id===source.archiveCostId&&row.data.productId===source.productId))throw new ConflictException('成本来源引用已不存在或不属于本公司档案');
 await em.delete(ResourceLink,{companyId,sourceType:record.type,sourceId:record.id,relation:Like('archive_cost:%')});
 for(const [index,source]of sources.entries())await em.insert(ResourceLink,{companyId,sourceType:record.type,sourceId:record.id,relation:`archive_cost:${index}`,targetType:'finance-product-costs',targetId:source.archiveCostId});
}
export interface ProductCostReferenceInfo{referenceCount:number|null;knownReferenceCount:number;referenceState:'known'|'unknown'}
/** Only explicit historical product IDs establish an unknown scope. No current base/name/amount inference. */
function historicalProductIds(snapshot:Record<string,unknown>){
 const ids=new Set<number>();if(positive(snapshot.productId))ids.add(snapshot.productId);if(Array.isArray(snapshot.productIds))for(const id of snapshot.productIds)if(positive(id))ids.add(id);
 for(const key of ['lines','components'])if(Array.isArray(snapshot[key]))for(const row of snapshot[key])if(object(row)&&positive(row.productId))ids.add(row.productId);
 return ids;
}
/** Batched DTO/delete reader. Snapshot facts remain authoritative even if links need rebuilding. */
export async function loadProductCostReferences(em:EntityManager,companyId:number,records:ResourceRecord[]):Promise<Map<number,ProductCostReferenceInfo>>{
 const costs=records.filter(row=>row.companyId===companyId&&row.type==='finance-product-costs'),out=new Map<number,ProductCostReferenceInfo>();if(!costs.length)return out;
 const products=await em.find(ResourceRecord,{where:{companyId,type:'finance-products',id:In([...new Set(costs.map(row=>Number(row.data.productId)))])}}),productIds=new Set(products.map(row=>row.id));
 for(const cost of costs)if(!positive(cost.data.productId)||!productIds.has(cost.data.productId))throw new ConflictException('成本记录所属档案不存在或不属于本公司');
 const ids=costs.map(row=>row.id),links=await em.find(ResourceLink,{where:{companyId,targetType:'finance-product-costs',targetId:In(ids)}}),snapshots=await em.find(ResourceRecord,{where:{companyId,type:'finance-cost-skus'}}),counts=new Map<number,number>(),covered=new Set<number>(),unknownProducts=new Set<number>();
 for(const row of snapshots){if(!object(row.data.snapshot))continue;const provenance=readCostSourceProvenance(row.data.snapshot.sourceProvenance);if(object(row.data.snapshot.sourceProvenance)&&row.data.snapshot.sourceProvenance.version===1&&!provenance)throw new ConflictException('成本来源快照格式不完整，无法确认引用');if(provenance){covered.add(row.id);for(const source of provenance.archiveCosts)if(costs.some(cost=>cost.id===source.archiveCostId&&cost.data.productId===source.productId))counts.set(source.archiveCostId,(counts.get(source.archiveCostId)??0)+1);if(!provenance.complete)for(const id of historicalProductIds(row.data.snapshot))unknownProducts.add(id);}else for(const id of historicalProductIds(row.data.snapshot))unknownProducts.add(id);}
 for(const link of links)if(link.relation!=='manual'&&!(link.sourceType==='finance-cost-skus'&&covered.has(link.sourceId)))counts.set(link.targetId,(counts.get(link.targetId)??0)+1);
 for(const cost of costs){const count=counts.get(cost.id)??0,unknown=positive(cost.data.productId)&&unknownProducts.has(cost.data.productId);out.set(cost.id,{referenceCount:unknown?null:count,knownReferenceCount:count,referenceState:unknown?'unknown':'known'});}return out;
}
