import {BadRequestException} from '@nestjs/common';
import {EntityManager} from 'typeorm';
import {ResourceLink,ResourceRecord} from '../entities';
/** 只认同公司真实ID引用；旧字面名称或未知历史不作为身份映射。 */
export async function assertBrandReferenceChanges(em:EntityManager,companyId:number,existing:ResourceRecord,data:Record<string,unknown>){
 const nameChanged=String(data.name??'')!==String(existing.data.name??''),codeChanged=String(data.code??'')!==String(existing.data.code??'');
 if(!nameChanged&&!codeChanged)return;
 const records=await em.createQueryBuilder(ResourceRecord,'r').where('r.companyId=:company AND r.type IN (:...types)',{company:companyId,types:['finance-products','finance-base-codes','finance-bundles']}).andWhere("(JSON_EXTRACT(r.data,'$.brandId')=:brand OR JSON_EXTRACT(r.data,'$.codeBrandId')=:brand)",{brand:existing.id}).getMany();
 const archiveReferences=records.some(record=>record.type==='finance-products'&&record.data.brandId===existing.id);
 if(nameChanged&&archiveReferences)throw new BadRequestException('该品牌已被商品档案引用，不能直接改名');
 if(codeChanged&&(records.length||await em.count(ResourceLink,{where:{companyId,targetType:'finance-brands',targetId:existing.id}})))throw new BadRequestException('该字典项已被业务数据引用，不能修改编码');
}
