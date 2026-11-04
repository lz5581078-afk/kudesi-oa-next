import { BadRequestException } from '@nestjs/common';
import { FINANCE_RESOURCE_DEFS, LOGISTICS_CENT_SCALE, UNIT_CENT_SCALE, unitYuanText, validUnitCents } from '@kudesi/shared';
import { EntityManager } from 'typeorm';
import { ResourceRecord } from '../entities';
import { unitLabelFor, type UnitLists } from './unit-options';

/** An already authorised, ACL-filtered product DTO. No dependency on ResourcesService. */
export interface ProductReferenceCsvRecord {
  id: number; type: string; status: string; statusReason: string | null;
  data: Record<string, unknown>;
  optionLabels?: Record<string, string>;
}
type Column = readonly [string, string];
const moneyKeys = new Set(['purchasePrice', 'freight', 'handlingFee']);
const money: readonly Column[] = [['purchasePrice','采购价'],['freight','运费'],['handlingFee','装卸费']];
const ending: readonly Column[] = [['status','状态'],['reason','停用原因'],['categoryCode','分类标识']];
const raw: readonly Column[] = [['code','系统自动编号'],['materialCode','原料生产编码'],['name','原料名称'],['originArea','产区'],['supplierName','供应商名称'],['supplierCode','供应商简称编码'],['categoryPath','所属分类'],['specQty','规格'],['specUnit','名称单位'],['purchaseSpec','系统规格'],...money,['categoryCode','分类标识']];
const purchased: readonly Column[] = [['code','外购成品编号'],['name','外购成品名称'],['brand','品牌'],['specQty','名称规格'],['specUnit','名称单位'],['purchaseSpec','系统规格'],['categoryPath','所属分类'],['supplyMode','供货方式'],['weight','称重重量'],...money,...ending];
const packaging: readonly Column[] = [['code','产品包装编号'],['categoryPath','所属分类'],['packagingCategory','包装类别'],['name','包装名称'],['brand','品牌'],['dimensions','尺寸'],['dimensionUnit','尺寸单位'],['capacities','容量明细'],['printingCompany','包装印刷公司'],['weight','重量'],['weightUnit','重量单位'],['purchaseSpec','系统规格'],...money,['orderStock','订单库存'],['actualStock','实际库存'],...ending];
export const PRODUCT_REFERENCE_CSV_COLUMNS: Readonly<Record<string, readonly Column[]>> = {
  raw,
  shipping_material: raw.map(([key,label]) => [key, key === 'materialCode' ? '物料生产编码' : key === 'name' ? '发货物料名称' : key === 'specUnit' ? '规格单位' : label] as const),
  self_made: [['code','自产成品编号'],['name','自产成品名称'],['brand','品牌'],['specQty','名称规格'],['specUnit','名称单位'],['productPackagingSpec','产品包装规格'],['productPackagingUnit','产品包装单位'],['purchaseSpec','系统规格'],['categoryPath','所属分类'],['weight','称重重量'],...money,...ending],
  original_purchase: purchased, supplier_oem: purchased,
  package: packaging,
  oem_package: packaging.filter(([key]) => key !== 'status' && key !== 'reason').map(([key,label]) => [key,key === 'code' ? 'OEM包装编号' : label] as const),
};
const familyTitles: Record<string,string> = {raw:'原料档案',shipping_material:'发货物料档案',self_made:'自产成品档案',original_purchase:'原装采购成品档案',supplier_oem:'供应商 OEM 成品档案',package:'产品包装档案',oem_package:'OEM包装档案'};
const text = (v: unknown): string => typeof v === 'string' || typeof v === 'number' ? String(v) : '';
const id = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;
const cell = (v: unknown) => { const value=text(v); const s=/^[=+\-@\t\r]/.test(value)?`'${value}`:value; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
interface Source { id:number; productId:unknown; supplierId:unknown; originArea:unknown; systemSpec:unknown; purchasePrice?:unknown }
interface Reference {id:number;type:string;title:string;parentId:unknown;categoryCode:unknown;shortCode:unknown;code:unknown;name:unknown;kind:unknown}

/** Exact archive CSV layout, independently of the table's visible columns/filters. SELECTs only. */
export async function exportProductReferenceCsv(em: EntityManager, user: {companyId:number}, family: string, records: readonly ProductReferenceCsvRecord[], canReadCost: boolean, options: {selectedCount?:number} = {}) {
  const definition = Object.prototype.hasOwnProperty.call(PRODUCT_REFERENCE_CSV_COLUMNS,family) ? PRODUCT_REFERENCE_CSV_COLUMNS[family] : undefined;
  if (!definition) throw new BadRequestException('请选择有效商品档案类型');
  const products = records.filter(p => p.type === 'finance-products' && id(p.id) && (family === 'original_purchase' || family === 'supplier_oem' ? p.data.archiveType === 'purchased' && (p.data.supplyMode || 'original_purchase') === family : p.data.archiveType === family));
  const columns = definition.filter(([key]) => canReadCost || !moneyKeys.has(key));
  const ids = [...new Set(products.map(p=>p.id))];
  let sources: Source[] = [];
  if (ids.length && ['raw','shipping_material'].includes(family)) {
    const query = em.createQueryBuilder(ResourceRecord,'s').select('s.id','id');
    for (const key of ['productId','supplierId','originArea','systemSpec',...(canReadCost?['purchasePrice']:[])]) query.addSelect(`JSON_EXTRACT(s.data,'$.${key}')`,key);
    sources = await query.where('s.companyId=:companyId AND s.type=:type AND s.archivedAt IS NULL AND s.status<>:deleted',{companyId:user.companyId,type:'finance-product-sources',deleted:'deleted'})
      .andWhere("JSON_EXTRACT(s.data,'$.productId') IN (:...ids)",{ids}).orderBy('s.id','ASC').getRawMany<Source>();
  }
  const refIds = [...new Set([...products.flatMap(p=>[id(p.data.brandId)]),...sources.map(s=>id(s.supplierId))].filter((n):n is number=>n!==undefined))];
  let refs: Reference[]=[];
  if(ids.length){
    const q=em.createQueryBuilder(ResourceRecord,'r').select('r.id','id').addSelect('r.type','type').addSelect('r.title','title');
    for(const key of ['parentId','categoryCode','shortCode','code','name','kind'])q.addSelect(`JSON_EXTRACT(r.data,'$.${key}')`,key);
    refs=await q.where('r.companyId=:companyId AND r.archivedAt IS NULL AND r.status<>:deleted',{companyId:user.companyId,deleted:'deleted'})
      .andWhere(refIds.length?'(r.type IN (:...treeTypes) OR (r.id IN (:...refIds) AND r.type IN (:...refTypes)))':'r.type IN (:...treeTypes)',{treeTypes:['finance-categories','finance-product-units'],refIds,refTypes:['finance-brands','finance-suppliers']}).getRawMany<Reference>();
  }
  const byId=new Map(refs.map(r=>[r.id,r]));
  const reference=(value:unknown,type:string)=>{const r=byId.get(id(value)??-1);return r?.type===type?r:undefined;};
  const path=(value:unknown)=>{
    let r=reference(value,'finance-categories'); const names:string[]=[], seen=new Set<number>();
    while(r){if(seen.has(r.id))return '';seen.add(r.id);names.unshift(r.title);if(!r.parentId)return names.join(' / ');r=reference(r.parentId,'finance-categories');}
    return '';
  };
  const units:UnitLists=new Map();
  for(const r of refs.filter(r=>r.type==='finance-product-units')){const kind=text(r.kind);const list=units.get(kind)??[];list.push({code:text(r.code),name:text(r.name)||r.title,active:true});units.set(kind,list);}
  const productDef=FINANCE_RESOURCE_DEFS.find(d=>d.key==='finance-products')!;
  const unit=(p:ProductReferenceCsvRecord,key:string)=>{const field=productDef.fields.find(f=>f.key===key);return field?unitLabelFor(units,field,p.data,p.data[key]):text(p.data[key]);};
  const sourcesByProduct=new Map<number,Source[]>();
  for(const s of sources){const productId=id(s.productId);if(productId){const list=sourcesByProduct.get(productId)??[];list.push(s);sourcesByProduct.set(productId,list);}}
  const rows: Record<string,unknown>[]=[];
  for(const p of products){
    const d=p.data, category=reference(d.categoryId,'finance-categories'), weightUnit=text(d.weightUnit||'kg');
    const row:Record<string,unknown>={};
    for(const [key]of columns)row[key]=d[key];
    Object.assign(row,{brand:reference(d.brandId,'finance-brands')?.title??'',categoryPath:path(d.categoryId),categoryCode:category?.categoryCode??'',status:p.status==='inactive'?'停用':p.status==='active'||p.status==='normal'?'正常':p.status,reason:p.status==='inactive'?p.statusReason??'':'',supplyMode:d.supplyMode==='supplier_oem'?'供应商OEM':'原装采购',weight:typeof d.weightG==='number'?d.weightG/(['package','oem_package'].includes(family)?weightUnit==='g'?1:weightUnit==='jin'?500:1000:1000):'',weightUnit:weightUnit==='g'?'克':weightUnit==='jin'?'斤':weightUnit==='kg'?'千克':weightUnit});
    for(const key of ['specUnit','productPackagingUnit','dimensionUnit','packagingCategory']) row[key]=unit(p,key);
    row.capacities=text(d.capacities).split(/\r?\n/).filter(Boolean).join('；');
    for(const key of moneyKeys) if(canReadCost){const scale=key==='freight'||key==='handlingFee'?LOGISTICS_CENT_SCALE:UNIT_CENT_SCALE;row[key]=validUnitCents(d[key],scale)?unitYuanText(d[key],scale):'';}
    if(['raw','shipping_material'].includes(family)){
      for(const s of sourcesByProduct.get(p.id)??[]){
        const supplier=reference(s.supplierId,'finance-suppliers');
        rows.push({...row,originArea:s.originArea,supplierName:supplier?.title??'',supplierCode:supplier?.shortCode??'',purchaseSpec:s.systemSpec,...(canReadCost?{purchasePrice:validUnitCents(s.purchasePrice)?unitYuanText(s.purchasePrice):''}:{})});
      }
    }else rows.push(row);
  }
  return {csv:`\uFEFF${[columns.map(([,label])=>cell(label)).join(','),...rows.map(row=>columns.map(([key])=>cell(row[key])).join(','))].join('\n')}`,count:rows.length,filename:`${familyTitles[family]}-${options.selectedCount?`已选${options.selectedCount}条`:'全部'}.csv`};
}
