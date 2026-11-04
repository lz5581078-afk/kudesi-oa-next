import {getResourceDef,LOGISTICS_CENT_SCALE,UNIT_CENT_SCALE,unitYuanText,sumUnitCents,validUnitCents, type FieldDef, type ResourceDef} from '@kudesi/shared';
import type {ResourceDto} from './api';
export const REFERENCE_PRODUCT_FAMILIES=['raw','shipping_material','self_made','original_purchase','supplier_oem','package','oem_package'] as const;
export function isReferenceProductFamily(value:unknown):boolean{return typeof value==='string'&&(REFERENCE_PRODUCT_FAMILIES as readonly string[]).includes(value);}

export function productReferencePageSize(family:string):number{try{const value=Number(localStorage.getItem(`kudesi.reference24.product.pageSize.${family}`));return [20,30,50].includes(value)?value:30;}catch{return 30;}}
export function saveProductReferencePageSize(family:string,value:number){try{localStorage.setItem(`kudesi.reference24.product.pageSize.${family}`,String(value));}catch{/* 本地偏好不可写不影响查询。 */}}
export function productReferenceNoun(family:string):string{return ({raw:'原料',shipping_material:'发货物料',self_made:'自产成品',original_purchase:'外购成品',supplier_oem:'外购成品',purchased:'外购成品',package:'产品包装',oem_package:'OEM包装'} as Record<string,string>)[family]||'商品';}

/** 24号各档案主页的列；只读投影，保存仍使用原资源字段。 */
export function productReferenceColumns(def:ResourceDef, family:string):FieldDef[]{
  const field=(key:string,label?:string):FieldDef=>({...def.fields.find(f=>f.key===key)!,...(label?{label}:{})});
  const extra=(key:string,label:string,type:FieldDef['type']='text'):FieldDef=>({key,label,type,group:'列表',readonly:true});
  const money=(key:string,label:string)=>({...field('freight',label),key});
  const code=field('code',['package','oem_package'].includes(family)?family==='package'?'产品包装编号':'OEM包装编号':['original_purchase','supplier_oem','purchased'].includes(family)?'外购成品编号':family==='self_made'?'自产成品编号':'系统自动编号');
  const base=[code,field('basicInfoFullName','基础信息全名')];
  const logistics=[field('freight'),field('handlingFee'),money('__freightHandling','运费装卸费')];
  const status=[extra('__status','状态'),extra('__actions','操作')];
  if(['raw','shipping_material'].includes(family))return [...base,extra('__sourceCount','供货来源','number'),extra('__sourceSupplier','最新供应商'),extra('__sourceOrigin','最新产区'),field('categoryId','所属分类'),extra('__categoryCode','分类标识'),field('purchaseSpec','系统规格'),field('purchasePrice'),...logistics,field('latestUnitCost','最新成本'),...status];
  if(['package','oem_package'].includes(family))return [...base,field('categoryId','所属分类'),field('capacities'),field('printingCompany','包装印刷公司'),field('weightG','重量'),field('purchaseSpec','系统规格'),field('purchasePrice'),...logistics,field('orderStock'),field('actualStock'),field('latestUnitCost','最新成本'),extra('__actions','操作')];
  if(['self_made','original_purchase','supplier_oem','purchased'].includes(family))return [...base,field('categoryId','所属分类'),field('weightG','称重重量'),field('purchasePrice'),...logistics,...status];
  return [...base,field('categoryId','所属分类'),field('weightG','称重重量'),...logistics,field('latestUnitCost','最新成本'),...status];
}
export function productReferenceRequiredColumns(family:string):string[]{return ['raw','shipping_material'].includes(family)?['latestUnitCost','__actions']:['package','oem_package'].includes(family)?['__actions']:['self_made','original_purchase','supplier_oem','purchased'].includes(family)?[]:['latestUnitCost'];}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
export function productReferenceCostText(cents:number,scale=UNIT_CENT_SCALE):string{const [whole,fraction='']=unitYuanText(cents,scale).split('.');return `¥${whole}.${fraction.padEnd(3,'0')}`;}
export function productReferenceText(field:FieldDef,row:ResourceDto):string|undefined{
  const d=row.data,key=field.key;
  if(key==='__sourceCount')return finite(d[key])?`${d[key]} 条`:'-';
  if(['__sourceSupplier','__sourceOrigin','__categoryCode'].includes(key))return typeof d[key]==='string'&&d[key]?String(d[key]):'-';
  if(key==='__freightHandling'){
    if(!validUnitCents(d.freight,LOGISTICS_CENT_SCALE)||!validUnitCents(d.handlingFee,LOGISTICS_CENT_SCALE)||d.freight===0&&d.handlingFee===0)return '-';
    try{return productReferenceCostText(sumUnitCents([d.freight,d.handlingFee],LOGISTICS_CENT_SCALE),LOGISTICS_CENT_SCALE);}catch{return '-';}
  }
  if(key==='weightG'){
    if(!finite(d.weightG)||!d.weightG)return '-';
    if(['package','oem_package'].includes(String(d.archiveType))){const unit=String(d.weightUnit||'kg');return `${d.weightG/(unit==='g'?1:unit==='jin'?500:1000)} ${unit==='g'?'克':unit==='jin'?'斤':'千克'}`;}
    return `${d.weightG/1000} kg`;
  }
  if(['orderStock','actualStock'].includes(key))return finite(d[key])?Number(d[key]).toFixed(2):'0.00';
  if(field.type==='money'){
    const scale=field.scale===LOGISTICS_CENT_SCALE||['freight','handlingFee','totalCost'].includes(key)?LOGISTICS_CENT_SCALE:UNIT_CENT_SCALE;
    return validUnitCents(d[key],scale)?key==='purchasePrice'&&d.archiveType==='purchased'?`¥${(Number(d[key])/100).toFixed(2)}`:productReferenceCostText(Number(d[key]),scale):key==='latestUnitCost'?'未维护':'-';
  }
  return undefined;
}
export function productReferenceContent(field:FieldDef,row:ResourceDto,text:string){
  if(text==='-'||text==='未维护')return text;
  if(field.key==='basicInfoFullName')return <span className="reference-product-main-text">{text}</span>;
  const d=row.data,unit=String(d.purchaseSpec||row.optionLabels?.specUnit||d.specUnit||'单位');
  if(['freight','handlingFee','__freightHandling'].includes(field.key))return <span className="product-reference-money"><strong>{text}</strong><small>/ {unit}</small></span>;
  if(field.key==='latestUnitCost'&&finite(d.latestUnitCost)){
    const choices=getResourceDef('finance-product-costs')?.fields.find(f=>f.key==='costType')?.options;
    const type=choices?.find(option=>option.value===d.latestCostType)?.label||String(d.latestCostType||'成本');
    return <span className="product-reference-money"><strong>{text} / {unit}</strong><small>{type}{d.latestCostFrom?` · ${String(d.latestCostFrom)}生效`:''}</small></span>;
  }
  return text;
}
