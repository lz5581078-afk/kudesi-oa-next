import {getResourceDef,unitOptionFromText,financeBankReferenceLabel,financeBookingReferenceLabel} from '@kudesi/shared';
import type {ResourceDto} from '../../resources/api';
export interface PickOption { id: number; title: string; detail?: string; data?: Record<string, unknown>; optionLabels?: Record<string,string> }
/** 制单商品选择器的名称/品牌/名称规格；基础信息全称属于另一种展示口径。 */
export function referenceProductLabel(item: Pick<ResourceDto,'title'|'data'|'refLabels'|'optionLabels'>): string {
  const text=(value:unknown)=>String(value??'').trim();
  const rawUnit=text(item.data.specUnit),unit=item.optionLabels?.specUnit||unitOptionFromText(rawUnit)?.label||rawUnit;
  return [text(item.data.name)||item.title||'未命名商品',text(item.refLabels?.brandId),[text(item.data.specQty),unit].filter(Boolean).join('')].filter(Boolean).join(' · ');
}


export interface SearchPickProps {
 type:string;value:number|null|undefined;label?:string;onChange:(id:number|null,label:string,data?:Record<string,unknown>,optionLabels?:Record<string,string>)=>void;
 placeholder?:string;fieldKey?:string;fieldValue?:string;ariaLabel?:string;options?:PickOption[];referenceLabel?:'booking'|'party';excludeIds?:readonly number[];emptyTextPlaceholder?:string;
}
export function referencePickOption(type:string,item:ResourceDto,presentation?:'booking'|'party'):PickOption {
 let title=type==='finance-products'?referenceProductLabel(item):item.title;
 if(type==='bank-accounts'&&item.data.kind){
  title=financeBankReferenceLabel(item.data,item.title,item.refLabels?.storeId);
 }
 if(presentation==='party'){
  const name=String(item.data.name||item.title),code=String(item.data.code||'');
  if(type==='stores'){
   const platform=String(item.data.platform||''),platformLabel=item.optionLabels?.platform||getResourceDef('stores')?.fields.find(field=>field.key==='platform')?.options?.find(option=>option.value===platform)?.label||platform||'其他';
   title=[platformLabel,name,String(item.data.storeNo||'')].filter(Boolean).join(' · ');
  }else title=[name,code].filter(Boolean).join(' · ');
 }
 if(presentation==='booking')title=financeBookingReferenceLabel(type,item.data,item.title,item.refLabels?.storeId);
 return{id:item.id,title,data:item.data,optionLabels:item.optionLabels,...(!presentation&&item.data.code?{detail:String(item.data.code)}:{})};
}
