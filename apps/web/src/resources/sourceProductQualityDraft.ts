import {archiveQualityContext,archiveQualityFields,validSourceQualityConfirmation,type SourceQualityFacts,type SourceQualityConfirmations} from '@kudesi/shared';
import type { ResourceDto } from './api';
import { orderedSourceRows,type SourceRow } from './ProductFormParts';
import { validBomRows,type BomDraftRow } from './BomDraft';
import { sourceQualityRowKey,withSourceQualityKey } from './sourceQualityRows';

/** 与实际 collection 共用顺序；此处事实只用于提示，服务端会重新锁定和读取。 */
export function sourceProductQualityDraft(parent:Record<string,unknown>,productId:number|null,sources:SourceRow[],composition:BomDraftRow[],records:Map<string,ResourceDto>,includeSources:boolean,includeComposition:boolean) {
  const normalizedSources=sources.map(withSourceQualityKey),normalizedComposition=composition.map(withSourceQualityKey);
  const sourceRows=includeSources?orderedSourceRows(normalizedSources):[],bomRows=includeComposition?validBomRows(normalizedComposition):[];
  const rows=[
    ...sourceRows.map((row,index)=>({type:'finance-product-sources' as const,index,key:sourceQualityRowKey(row),...(row.rowId?{id:row.rowId}:{})})),
    ...bomRows.map((row,index)=>({type:'finance-product-boms' as const,index,key:sourceQualityRowKey(row),...(row.rowId?{id:row.rowId}:{})})),
  ];
  const facts={version:1 as const,productId,parent,sources:normalizedSources.map(row=>({key:sourceQualityRowKey(row),...(row.rowId?{id:row.rowId}:{}),status:row.stopped?'inactive':'active',supplierId:row.supplierId,originArea:row.originArea,systemSpec:row.systemSpec,purchasePrice:row.purchasePrice})),composition:normalizedComposition.map(row=>{
    const record=row.id?records.get(`${row.kind}:${row.id}`):undefined;
    if(row.id&&!record)throw new Error('组成档案正在读取，请稍后再保存。');
    const kind=row.importedLabor?'imported_labor' as const:row.kind==='labor'?'labor' as const:['raw','package','oem_package'].includes(row.group)?row.group:'unknown' as const;
    return {key:sourceQualityRowKey(row),...(row.rowId?{id:row.rowId}:{}),kind,referenceId:row.id,qty:row.qty,unit:row.importedLabor?'':row.kind==='labor'?record?.refLabels.unitId??'':record?.data.specUnit??'',lossPercent:row.kind==='labor'?0:row.loss||0,...(row.importedLabor?{importedLaborName:row.importedLabor.name}:{})};
  })};
  return {facts,rows};
}

/** 只携带同一事实上下文且当前仍为零的逐项确认，不从旧说明文字升级。 */
export function currentSourceQualityConfirmations(value:unknown,facts:SourceQualityFacts):SourceQualityConfirmations {
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 const context=archiveQualityContext(facts),rows=value as Record<string,unknown>,out:SourceQualityConfirmations={};
 for(const field of archiveQualityFields(facts.parent,{sourceFacts:facts,canCost:true})){
  if(!['zero','weight','optionalGroup'].includes(field.mode)||field.value==null||field.value===''||Number(field.value)!==0)continue;
  const receipt=rows[field.id];if(validSourceQualityConfirmation(receipt,context))out[field.id]={reason:receipt.reason,context:receipt.context};
 }
 return out;
}
