import { pinyin } from 'pinyin-pro';
const initials=(value:string)=>pinyin(value,{pattern:'first',toneType:'none',type:'array'}).join('').replace(/[^a-z0-9]/gi,'').toUpperCase();
import { BadRequestException } from '@nestjs/common';
import { validUnitCents, specificationWeightG, systemWeightG } from '@kudesi/shared';
import { ResourceRecord } from '../entities';
import type { BeforeSaveContext } from './resource-rules';
import { trustedResourceImport } from './resource-import-capability';
import { buildSnapshot } from './base-code-support';
import { guardReferenced, inspectBaseCodeReferences } from './base-code-composed';

export async function validateCodingReferences({em,user,data}:BeforeSaveContext,allowCategoryParents=false) {
  for(const [field,kind]of [['codeDictionaryCategoryId','product_category'],['varietyDictionaryId','variety']] as const){
    if(data[field]==null)continue;
    const record=await em.findOne(ResourceRecord,{where:{id:Number(data[field]),companyId:user.companyId,type:'finance-code-dictionaries'}});
    if(!record || record.data.kind!==kind || record.status!=='active')throw new BadRequestException('请选择有效的同类编码字典');
    if(kind==='product_category' && !allowCategoryParents){
      const children=await em.find(ResourceRecord,{where:{companyId:user.companyId,type:'finance-code-dictionaries'}});
      if(children.some(row=>row.data.parentId===record.id))throw new BadRequestException('商品编码分类必须选择末级');
    }
  }
}
/** Productless historical codes can only originate inside a trusted workbook transaction. */
export async function beforeExternalBaseCode(ctx:BeforeSaveContext):Promise<boolean> {
  const {em,user,data,existing,status}=ctx;
  const trusted=trustedResourceImport(em,user,'base_codes');
  if(data.origin!=='external_import' && existing?.data.origin!=='external_import'){
    if(data.externalCost!==undefined || data.externalPurchasePrice!==undefined)throw new BadRequestException('导入成本仅适用于历史导入编码');
    return false;
  }
  if(!existing && !trusted)throw new BadRequestException('历史编码只能通过商品数据导入建立');
  if(existing && existing.data.origin!=='external_import' && !trusted)throw new BadRequestException('不能把普通编码改为历史导入编码');
  if(existing?.data.origin==='external_import' && data.origin!=='external_import')throw new BadRequestException('历史导入编码不能更换来源模式');
  await validateCodingReferences(ctx);
  if(existing && existing.data.weightG!==data.weightG && (await inspectBaseCodeReferences(em,user.companyId,existing)).level==='effective')throw new BadRequestException('该商品编码已有生效引用，重量不能修改');
  if(!String(data.code ?? '').trim() || !String(data.name ?? '').trim())throw new BadRequestException('历史编码和名称必填');
  data.code=String(data.code).trim();
  if(!/^[A-Za-z0-9+*_]+(-[A-Za-z0-9+*_]+)*$/.test(String(data.code)) || String(data.code).length>48)throw new BadRequestException('基础编码格式不正确');
  if(String(data.styleCode ?? '').trim() && (!/^[A-Za-z0-9+*_]+(-[A-Za-z0-9+*_]+)*$/.test(String(data.styleCode)) || String(data.styleCode).length>48))throw new BadRequestException('外部款式编码格式不正确');
  if(data.productId!=null || data.canonicalId!=null)throw new BadRequestException('历史导入编码通过独立构成关联档案，不能设置虚构来源或马甲');
  if(!(Number(data.codeSpecQty)>0) || !data.codeSpecUnit)throw new BadRequestException('规格数量和规格单位必填');
  if(data.weightG!=null && (typeof data.weightG!=='number' || !Number.isFinite(data.weightG) || data.weightG<0))throw new BadRequestException('重量必须为非负数');
  for(const field of ['externalCost','externalPurchasePrice'])if(data[field]!=null && (!validUnitCents(data[field]) || Number(data[field])<0))throw new BadRequestException('导入成本金额无效');
  if(!String(data.styleCode ?? '').trim()){
    const category=await em.findOne(ResourceRecord,{where:{id:Number(data.codeDictionaryCategoryId),companyId:user.companyId,type:'finance-code-dictionaries'}});
    const brand=typeof data.codeBrandId==='number' ? await em.findOne(ResourceRecord,{where:{id:data.codeBrandId,companyId:user.companyId,type:'finance-brands'}}) : null;
    const variety=typeof data.varietyDictionaryId==='number' ? await em.findOne(ResourceRecord,{where:{id:data.varietyDictionaryId,companyId:user.companyId,type:'finance-code-dictionaries'}}) : null;
    data.styleCode=[category?.data.code,brand?.data.code,variety?.data.code || initials(String(data.varietyName ?? ''))].filter(Boolean).join('-');
  }
  const units=await em.find(ResourceRecord,{where:{companyId:user.companyId,type:'finance-product-units'}});
  const specificationUnit=units.find(row=>row.data.kind==='spec_unit' && row.data.code===data.codeSpecUnit);
  const unitName=String(specificationUnit?.data.name || data.codeSpecUnit);
  if(!String(data.baseUnit ?? '').trim())data.baseUnit=unitName;
  data.spec=String(data.spec || `${data.codeSpecQty}${unitName}`);
  data.cost=data.externalCost;data.purchasePrice=data.externalPurchasePrice;
  data.profileManual=true;
  if(status==='verified'){
    const probe={id:existing?.id ?? 0,title:String(data.code),data} as ResourceRecord;
    const report=await buildSnapshot(em,user.companyId,probe);
    if(report.issues.length)throw new BadRequestException(report.issues.map(issue=>issue.message).join('；'));
    data.snapshot=JSON.stringify(report.snapshot);data.signature=report.signature;data.verifiedAt=new Date().toISOString().slice(0,10);
  }else {delete data.signature;delete data.verifiedAt;if(status==='pending')delete data.snapshot;}
  await guardReferenced(em,user,existing,data,status);
  return true;
}

/** Missing historical weight follows the original import: true components first, then explicit weight unit. */
export async function importedBaseWeight(ctx:Pick<BeforeSaveContext,'em'|'user'>,base:ResourceRecord,facts?:ResourceRecord[]):Promise<number|null> {
  if(Number(base.data.weightG)>0)return Number(base.data.weightG);
  const {em,user}=ctx;
  const links=facts?.filter(row=>row.type==='finance-base-code-lines') ?? await em.find(ResourceRecord,{where:{companyId:user.companyId,type:'finance-base-code-lines'}});
  const own=links.filter(link=>link.data.baseCodeId===base.id);
  let grams=0;
  for(const link of own){const product=facts ? facts.find(row=>row.type==='finance-products' && row.id===link.data.productId) : await em.findOne(ResourceRecord,{where:{id:Number(link.data.productId),companyId:user.companyId,type:'finance-products'}});const weight=product?.data.weightG;if(typeof weight==='number')grams+=weight*Number(link.data.qty);}
  if(grams>0)return Math.round(grams*1e6)/1e6;
  const units=facts?.filter(row=>row.type==='finance-product-units') ?? await em.find(ResourceRecord,{where:{companyId:user.companyId,type:'finance-product-units'}});
  const unit=units.find(row=>row.data.kind==='spec_unit' && row.data.code===base.data.codeSpecUnit);
  return specificationWeightG(base.data.codeSpecQty,base.data.codeSpecUnit) ?? (unit ? systemWeightG(`${base.data.codeSpecQty}${unit.data.name}`) : null);
}
