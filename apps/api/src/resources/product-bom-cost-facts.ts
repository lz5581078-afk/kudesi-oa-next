import {LOGISTICS_CENT_SCALE,validUnitCents} from '@kudesi/shared';
import type {ResourceRecord} from '../entities';
export interface ProductBomCostFacts {unitCost:number|null;freight:number|null;handlingFee:number|null}
/** Public quote projection only; authorization belongs to the canonical DTO boundary. */
export function extractProductBomCostFacts(record:Pick<ResourceRecord,'data'|'type'>):ProductBomCostFacts|undefined {
 if(record.type!=='finance-product-boms')return undefined;
 const data=record.data,snapshot=data.archiveBomCostSnapshot;
 if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))return undefined;
 const fact=snapshot as Record<string,unknown>;if(fact.version!==1)return undefined;
 const id=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
 const component=id(data.componentId),labor=id(data.laborId);
 if(component===labor)return undefined;
 if(component?(fact.componentId!==data.componentId||fact.laborId!=null||data.laborId!=null):(fact.laborId!==data.laborId||fact.componentId!=null||data.componentId!=null))return undefined;
 for(const key of ['unitCost','freight','handlingFee'])if(fact[key]!==null&&(!validUnitCents(fact[key],key==='unitCost'?4:LOGISTICS_CENT_SCALE)||Number(fact[key])<0))return undefined;
 return {unitCost:fact.unitCost as number|null,freight:fact.freight as number|null,handlingFee:fact.handlingFee as number|null};
}
