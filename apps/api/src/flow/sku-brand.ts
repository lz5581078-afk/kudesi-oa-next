import {BadRequestException} from '@nestjs/common';
import type {EntityManager} from 'typeorm';
import type {SkuSpec} from '@kudesi/shared';
import {ResourceRecord} from '../entities';
const idOf=(value:unknown)=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
/** Same archive/composed/external source identity used by the unified base-code facts. */
export async function inheritedSkuBrandId(em:EntityManager,companyId:number,baseCodeId:number){
 const selected=await em.findOneBy(ResourceRecord,{companyId,id:baseCodeId,type:'finance-base-codes'});if(!selected)return null;
 const base=typeof selected.data.canonicalId==='number'?await em.findOneBy(ResourceRecord,{companyId,id:selected.data.canonicalId,type:'finance-base-codes'}):selected;if(!base)return null;
 if(base.data.origin==='composed'||base.data.origin==='external_import')return idOf(base.data.codeBrandId);
 const productId=idOf(base.data.productId),product=productId?await em.findOneBy(ResourceRecord,{companyId,id:productId,type:'finance-products'}):null;return idOf(product?.data.brandId);
}
export async function resolveSkuBrandId(em:EntityManager,companyId:number,spec:SkuSpec,payload:Record<string,unknown>,required=false){
 const id=spec.brandId??idOf(payload.brandId)??(spec.main[0]?await inheritedSkuBrandId(em,companyId,spec.main[0].baseCodeId):null);
 if(required){if(!id)throw new BadRequestException('主商品未关联品牌，请选择组合品牌');const brand=await em.findOneBy(ResourceRecord,{companyId,id,type:'finance-brands',status:'active'});if(!brand||!String(brand.data.code??'').trim()||!brand.title.trim())throw new BadRequestException('组合品牌无效，请从已启用的品牌中重新选择');}
 return id;
}
