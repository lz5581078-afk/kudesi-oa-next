import {unitOptionFromText} from '@kudesi/shared';
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
 placeholder?:string;fieldKey?:string;fieldValue?:string;ariaLabel?:string;options?:PickOption[];
}
export function referencePickOption(type:string,item:ResourceDto):PickOption {
 let title=type==='finance-products'?referenceProductLabel(item):item.title;
 if(type==='bank-accounts'&&item.data.kind){
  const kinds:Record<string,string>={company_public:'公司公户',company_card:'公司银行卡',cashier_account:'公司出纳账户',store_public:'店铺公户',store_personal_card:'店铺个人银行卡'};
  const owner=item.refLabels?.storeId||item.data.ownerName||item.data.accountName||item.title||'未命名账户';
  const suffix=String(item.data.accountNo||'').slice(-4);
  title=(kinds[String(item.data.kind)]||'资金账户')+' · '+owner+(suffix?' · 尾号'+suffix:'');
 }
 return{id:item.id,title,data:item.data,optionLabels:item.optionLabels,...(item.data.code?{detail:String(item.data.code)}:{})};
}
