import {BadRequestException} from '@nestjs/common';
import {composeBaseDefinition,baseDefinitionCodeErrors,FINANCE_RESOURCE_DEFS,scaledDecimal} from '@kudesi/shared';
import {EntityManager} from 'typeorm';
import {ResourceRecord} from '../entities';
import {loadUnitLists,allowedValues,unitLabelFor} from './unit-options';
import {definitionCodeInitials} from './code-initials';
import type {SnapshotReadContext} from './snapshot-read-context';
type Data=Record<string,unknown>;
const text=(value:unknown)=>typeof value==='string'?value:'';
export async function independentDefinitionFacts(em:EntityManager,companyId:number,data:Data,reader?:SnapshotReadContext){
 reader?.assertScope(em,companyId);
 const one=(type:string,id:number)=>reader?reader.one(type,id):em.findOneBy(ResourceRecord,{companyId,type,id});
 const categories:ResourceRecord[]=[],errors:string[]=[],seen=new Set<number>();let id=data.codeDictionaryCategoryId;
 if(id==null)errors.push('请选择商品编码末级分类');
 while(id!=null){if(typeof id!=='number'||!Number.isSafeInteger(id)||id<=0||seen.has(id)||seen.size>=4)throw new BadRequestException('商品编码分类父链无效');seen.add(id);const row=await one('finance-code-dictionaries',id);if(!row||row.archivedAt||row.status!=='active'||row.data.kind!=='product_category')throw new BadRequestException('商品编码分类不存在、已停用或不属于当前公司');categories.unshift(row);id=row.data.parentId;}
 if(categories.length){const all=reader?await reader.all('finance-code-dictionaries'):await em.find(ResourceRecord,{where:{companyId,type:'finance-code-dictionaries'}});if(all.some(row=>!row.archivedAt&&row.data.kind==='product_category'&&row.data.parentId===categories[categories.length-1].id))throw new BadRequestException('商品编码分类必须选最末级');}
 let brand:ResourceRecord|null=null;if(data.codeBrandId!=null){if(typeof data.codeBrandId!=='number')throw new BadRequestException('品牌无效');brand=await one('finance-brands',data.codeBrandId);if(!brand||brand.archivedAt||brand.status!=='active')throw new BadRequestException('品牌不存在、已停用或不属于当前公司');}
 const varietyName=text(data.varietyName).normalize('NFKC').trim().replace(/\s+/g,' '),varietyCode=definitionCodeInitials(varietyName);if(!varietyName)errors.push('品种必填');if(varietyName.length>160)errors.push('品种不能超过160个字符');if(varietyName&&!varietyCode)errors.push('品种必须包含可用于生成编码的中文、英文或数字');
 const quantity=typeof data.codeSpecQty==='number'?data.codeSpecQty:null;if(quantity==null||!Number.isFinite(quantity)||quantity<=0)errors.push('规格必须大于0');else try{scaledDecimal(quantity,6);}catch{throw new BadRequestException('规格最多保留六位小数');}
 const units=reader?await reader.units():await loadUnitLists(em,companyId),field=FINANCE_RESOURCE_DEFS.find(def=>def.key==='finance-base-codes')!.fields.find(field=>field.key==='codeSpecUnit')!,unitCode=text(data.codeSpecUnit),allowed=allowedValues(units,field,data)||field.options!.map(option=>option.value);if(!unitCode)errors.push('请选择规格单位');else if(!allowed.includes(unitCode))throw new BadRequestException('规格单位不存在、已停用或不属于当前公司');const unitName=unitLabelFor(units,field,data,unitCode);
 const generated=composeBaseDefinition({categoryCodes:categories.map(row=>text(row.data.code)),categoryNames:categories.map(row=>row.title),brandCode:text(brand?.data.code),brandName:brand?.title||'',varietyCode,varietyName,quantity:Number.isFinite(quantity)?quantity:null,unitCode,unitName});
 return{generated,errors,codeErrors:baseDefinitionCodeErrors(generated.code),styleErrors:baseDefinitionCodeErrors(generated.styleCode,'款式编码'),unitName,varietyName,definition:{categories:categories.map(row=>({id:row.id,name:row.title,code:text(row.data.code),status:row.status})),brand:brand?{id:brand.id,name:brand.title,code:text(brand.data.code),status:brand.status}:null,varietyName,quantity,unitCode,unitName}};
}
