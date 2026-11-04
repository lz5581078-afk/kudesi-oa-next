import {bundleLaborUnit} from '../resources/bundle-component-validation';
import {BadRequestException} from '@nestjs/common';
import {scaledDecimal,type SkuSpec,type WarehouseSpec} from '@kudesi/shared';
import {type EntityManager} from 'typeorm';
import {AuditLog,FlowRun,ResourceRecord} from '../entities';
import type {AuthUser} from '../common/auth.decorators';
import type {LineInput} from '../resources/bundle-tools.service';
import {costCompositionFacts} from '../resources/cost-components';
import {sigOf} from '../resources/base-code-support';
import type {FlowConfirmation} from './flow-confirmation.dto';
type Target={platformId:number;platformName:string;code:string;name:string;reuse:{id:number}|null};
type Plan=Array<{name:string;lines:LineInput[];targets:Target[]}>;
function identity(input:Array<{role?:unknown;baseCodeId?:unknown;productId?:unknown;qty?:unknown}>){
 const quantities=new Map<string,bigint>();
 for(const line of input){if(line.role!=='main'&&line.role!=='gift')continue;const id=typeof line.productId==='number'?'P'+line.productId:typeof line.baseCodeId==='number'?'B'+line.baseCodeId:'';if(!id||typeof line.qty!=='number'||!Number.isFinite(line.qty)||line.qty<=0)return null;const key=line.role+':'+id;quantities.set(key,(quantities.get(key)??0n)+scaledDecimal(line.qty,6));}
 return quantities.size?JSON.stringify([...quantities].sort(([a],[b])=>a.localeCompare(b)).map(([key,quantity])=>[key,String(quantity)])):null;
}
export async function skuDuplicateState(em:EntityManager,companyId:number,run:FlowRun,payload:Record<string,unknown>,warehouse:WarehouseSpec[]|undefined,plan:Plan){
 const bundles=(await em.find(ResourceRecord,{where:{companyId,type:'finance-bundles'},order:{id:'ASC'}})).filter(row=>!row.archivedAt),ids=bundles.map(row=>row.id),lines=ids.length?await em.find(ResourceRecord,{where:{companyId,type:'finance-bundle-lines'}}):[];
 const specs=payload.specs as SkuSpec[],wanted=specs.map(spec=>identity([...spec.main.map(line=>({...line,role:'main'})),...spec.gift.map(line=>({...line,role:'gift'}))]));
 const grouped=new Map<number,Record<string,unknown>[]>();for(const line of lines){if(line.archivedAt||!['main','gift'].includes(String(line.data.role)))continue;const id=Number(line.data.bundleId),group=grouped.get(id)??[];group.push(line.data);grouped.set(id,group);}
 const matches=bundles.filter(bundle=>{const key=identity(grouped.get(bundle.id)??[]);return key!==null&&wanted.includes(key);}).map(bundle=>({id:bundle.id,code:String(bundle.data.code??bundle.title),name:String(bundle.data.name??bundle.title)}));
 if(!matches.length)return {generatedDuplicates:matches,duplicateToken:undefined};
 const laborUnits=[];for(const id of [...new Set(plan.flatMap(item=>item.lines.filter(line=>line.role==='labor').map(line=>line.laborId!)))].sort((a,b)=>a-b)){const labor=await em.findOne(ResourceRecord,{where:{companyId,type:'finance-labor-costs',id}});laborUnits.push({id,unitId:labor?.data.unitId??null,unit:labor?await bundleLaborUnit(em,companyId,labor):''});}
 const inspections=[];for(const item of plan){const facts=await costCompositionFacts(em,companyId,{},item.lines as unknown as Record<string,unknown>[]);inspections.push({name:item.name,targets:item.targets,facts});}
 return {generatedDuplicates:matches,duplicateToken:sigOf(companyId,run.id,run.revision,{specs,scenarioId:payload.scenarioId,brandId:payload.brandId,platformIds:payload.platformIds,bundleCategoryId:payload.bundleCategoryId},warehouse??null,inspections,laborUnits,matches)};
}
export async function confirmSkuDuplicates(em:EntityManager,user:AuthUser,run:FlowRun,payload:Record<string,unknown>,warehouse:WarehouseSpec[]|undefined,plan:Plan,confirmation:FlowConfirmation|undefined){
 const state=await skuDuplicateState(em,user.companyId,run,payload,warehouse,plan);if(!state.generatedDuplicates.length)return;
 if(!confirmation||confirmation.confirmed!==true||confirmation.token!==state.duplicateToken||typeof confirmation.reason!=='string'||!confirmation.reason.trim()||confirmation.reason.length>500)throw new BadRequestException('已有主商品和赠品相同的SKU，请查重后二次确认并填写继续申请原因');
 const fact={actorId:user.id,confirmedAt:new Date().toISOString(),reason:confirmation.reason.trim(),matches:state.generatedDuplicates};payload._duplicateConfirmation=fact;
 await em.save(AuditLog,em.create(AuditLog,{companyId:user.companyId,actorId:user.id,action:'flow.application-duplicate.confirm',resourceType:'flow_run',resourceId:String(run.id),detail:fact}));
}
