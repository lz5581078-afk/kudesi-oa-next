import {createChecker} from '@kudesi/shared';
import type {EntityManager} from 'typeorm';
import type {AuthUser} from '../common/auth.decorators';
import {costCompositionFacts} from '../resources/cost-components';
import type {LineInput} from '../resources/bundle-tools.service';
export interface SkuInspection{stage:string;capturedAt:string;specs:Array<{name:string;totalCostCents:number|null;weightG:number|null;targets:Array<{platformId:number;platformName:string;code:string;name:string;existing?:boolean}>}>}
export async function captureSkuInspection(em:EntityManager,companyId:number,stage:string,plan:Array<{name:string;lines:LineInput[];targets:Array<{platformId:number;platformName:string;code:string;name:string;reuse:{id:number}|null}>}>):Promise<SkuInspection>{
 const specs=[];for(const item of plan){const facts=await costCompositionFacts(em,companyId,{},item.lines as unknown as Record<string,unknown>[]);specs.push({name:item.name,totalCostCents:facts.preShipCostCents,weightG:facts.weightG,targets:item.targets.map(target=>({platformId:target.platformId,platformName:target.platformName,code:target.code,name:target.name,existing:!!target.reuse}))});}
 return {stage,capturedAt:new Date().toISOString(),specs};
}
export function publicSkuInspection(raw:unknown,user:AuthUser){const snapshot=raw as SkuInspection|undefined;if(!snapshot||!Array.isArray(snapshot.specs))return undefined;const cost=createChecker(user.permissions)('product.cost.view');return {...snapshot,specs:snapshot.specs.map(({totalCostCents,...item})=>({...item,...(cost?{totalCostCents}:{})}))};}
