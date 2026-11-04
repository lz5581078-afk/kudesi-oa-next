import {useEffect,useState} from 'react';
import {LOGISTICS_CENT_SCALE,sumUnitCents,type CompositionGroup} from '@kudesi/shared';
import {useCostIdentityKey} from '../pages/finance/CostIdentityBoundary';
import {resourceApi,type ResourceDto} from './api';
import {loadResourceDirectory} from './resourceDirectory';
import {calculateDraftFacts} from './useProductDraftFacts';
import type {BomDraftRow} from './BomDraft';
const finite=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)?v:null;
export interface ProcurementEntry {row:ResourceDto;item:ResourceDto|null}
export interface ProductProcurementFacts {rawCost:number|null;packageCost:number|null;laborCost:number|null;freight:number|null;handling:number|null;logistics:number|null;rawWeightG:number|null;packageWeightG:number|null;weightG:number|null}
/** Adapter for the existing calculation. Labor quotes come exclusively from saved BOM facts. */
export function calculateProcurementViewFacts(entries:ProcurementEntry[],canCost:boolean,mode:'self'|'oem'='self'):ProductProcurementFacts{
 if(!entries.length)return {rawCost:null,packageCost:null,laborCost:null,freight:null,handling:null,logistics:null,rawWeightG:null,packageWeightG:null,weightG:null};
 const rows:BomDraftRow[]=[],records=new Map<string,ResourceDto>();let rawWeightKnown=true,packageWeightKnown=true,unknown=false;
 for(const {row,item}of entries){const labor=typeof row.data.laborId==='number'||row.data.importLineKind==='labor',group:CompositionGroup=labor?'labor':item?.data.archiveType==='package'||item?.data.archiveType==='oem_package'?item.data.archiveType:'raw';
  const id=labor?Number(row.data.laborId)||row.id:Number(row.data.componentId)||null;
  if(finite(row.data.qty)===null||!(Number(row.data.qty)>0))unknown=true;
  rows.push({kind:labor?'labor':'component',group,id,qty:finite(row.data.qty)??'',loss:labor?'':finite(row.data.lossPercent)??''});
  // Imported labor uses its real BOM row id only as an in-memory calculation key, never a catalog reference.
  if(labor){const saved=row.data.importLineKind==='labor'?finite(row.data.importLaborCost):finite(row.bomCostFacts?.unitCost);if(id)records.set(`labor:${id}`,{...row,data:{unitPrice:canCost?saved:null}});}
  else{if(item&&!['raw','package','oem_package'].includes(String(item.data.archiveType)))unknown=true;if(item&&id)records.set(`component:${id}`,{...item,data:{...item.data,purchasePrice:finite(item.data.purchasePrice)??(mode==='oem'?null:finite(item.data.latestUnitCost))}});if(!item||finite(item.data.weightG)===null){if(group==='raw')rawWeightKnown=false;else packageWeightKnown=false;}if(!item)unknown=true;}
 }
 const result=calculateDraftFacts(rows,records,canCost,mode),group=(name:string)=>unknown?null:result.groups[name]?.purchaseCost===undefined?(unknown?null:0):result.groups[name].purchaseCost;
 const a=group('package'),b=group('oem_package'),rawWeightG=rawWeightKnown&&!unknown?result.groups.raw?.weightG??0:null,packageWeightG=packageWeightKnown&&!unknown?(result.groups.package?.weightG??0)+(result.groups.oem_package?.weightG??0):null;
 return {rawCost:canCost?group('raw'):null,packageCost:canCost&&a!==null&&b!==null?sumUnitCents([a,b],LOGISTICS_CENT_SCALE):null,laborCost:canCost?group('labor'):null,freight:canCost&&!unknown?result.componentFreight:null,handling:canCost&&!unknown?result.componentHandling:null,logistics:canCost&&!unknown&&result.componentFreight!==null&&result.componentHandling!==null?sumUnitCents([result.componentFreight,result.componentHandling],LOGISTICS_CENT_SCALE):null,rawWeightG,packageWeightG,weightG:rawWeightG===null||packageWeightG===null?null:Math.round((rawWeightG+packageWeightG)*1e6)/1e6};
}
export function useProductProcurementFacts(record:ResourceDto,canCost:boolean){
 const identity=useCostIdentityKey(),enabled=record.data.archiveType==='self_made'||record.data.supplyMode==='supplier_oem',mode=record.data.supplyMode==='supplier_oem'?'oem':'self',key=JSON.stringify([identity,record.id,record.version,record.updatedAt,canCost,mode]);
 const [state,setState]=useState<{key:string;facts:ProductProcurementFacts|null;error:string}>({key:'',facts:null,error:''});
 useEffect(()=>{if(!enabled)return;let alive=true;const current=()=>alive;void(async()=>{
  const rows=await loadResourceDirectory('finance-product-boms',current,undefined,{includeInactive:true,preserveOrder:true,scopedQuery:{fieldKey:'productId',fieldValue:record.id}});if(!rows||!alive)return;
  const ids=[...new Set(rows.map(row=>row.data.componentId).filter((id):id is number=>typeof id==='number'))],items=new Map<number,ResourceDto|null>();
  await Promise.all(ids.map(async id=>{if(!alive)return;try{const item=await resourceApi.get('finance-products',id);if(alive)items.set(id,item);}catch{if(alive)items.set(id,null);}}));if(!alive)return;
  setState({key,facts:calculateProcurementViewFacts(rows.map(row=>({row,item:items.get(Number(row.data.componentId))??null})),canCost,mode),error:''});
 })().catch(error=>{if(alive)setState({key,facts:null,error:error instanceof Error?error.message:'组成事实读取失败'});});return()=>{alive=false;};},[key,enabled,record.id,canCost,mode]);
 return enabled&&state.key===key?state:{key,facts:null,error:''};
}
