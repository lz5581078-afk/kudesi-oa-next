import {BadRequestException,ConflictException} from '@nestjs/common';
import {baseDefinitionCodeErrors} from '@kudesi/shared';
import type {BeforeSaveContext,RuleHost} from './resource-rules';
import {EntityManager} from 'typeorm';
import {Company,ResourceRecord} from '../entities';
import {AuthUser} from '../common/auth.decorators';
import {independentDefinitionFacts} from './base-definition-facts';
import {buildSnapshot,composedFacts} from './base-code-support';
import {guardReferenced,afterBaseCodeLineChange,seedMainLine} from './base-code-composed';
import {beginBaseCodeForm,endBaseCodeForm} from './base-code-form-scope';
const text=(value:unknown)=>typeof value==='string'?value:'';
/** 明确独立目录的人工定义不伪造单一商品来源；旧三条来源分支保持原规则。 */
export async function beforeIndependentBaseCode(ctx:BeforeSaveContext){const {em,user,data,existing,status}=ctx;if(data.origin!=='composed'||data.codeDictionaryCategoryId==null||existing?.data.productId!=null)return false;
 await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
 if(existing&&existing.data.origin!=='composed')throw new BadRequestException('已有的基础编码不能改成独立多构成定义');if(!existing&&data.productId!=null)throw new BadRequestException('独立商品定义通过组成关联档案，不能指定单一来源商品');if(data.canonicalId!=null)throw new BadRequestException('独立商品定义不能作为马甲');
 const facts=await independentDefinitionFacts(em,user.companyId,data);if(facts.errors.length)throw new BadRequestException(facts.errors.join('；'));
 const code=text(data.code).trim().toUpperCase()||facts.generated.code,style=text(data.styleCode).trim().toUpperCase()||facts.generated.styleCode,errors=[...baseDefinitionCodeErrors(code),...baseDefinitionCodeErrors(style,'款式编码')];if(errors.length)throw new BadRequestException(errors.join('；'));
 const name=text(data.name).trim()||facts.generated.name,shortName=text(data.shortName).trim()||facts.generated.shortName;if(!name||!shortName)throw new BadRequestException('商品名称和商品简称必填');if(!existing&&(name.length>255||shortName.length>160))throw new BadRequestException('新建商品名称最多255个字符，简称最多160个字符');
 const conflict=await ctx.host.findByUnique(em,user.companyId,'finance-base-codes',code);if(conflict&&conflict.id!==existing?.id)throw new ConflictException('存在相同商品基础编码');
 data.varietyName=facts.varietyName;data.code=code;data.styleCode=style;data.name=name;data.shortName=shortName;data.spec=text(data.spec)||facts.generated.spec;data.baseUnit=text(data.baseUnit)||facts.unitName;
 if(existing&&em.queryRunner?.data.confirmBaseProfile){data.profileManual=true;if(typeof data.weightG==='number'&&data.weightG>=0)data.profileWeightOverride=data.weightG;}
 const totals=existing?await composedFacts(em,user.companyId,existing.id):null;
 if(status!=='verified'||existing?.status!=='verified'){data.weightG=data.profileWeightOverride??(totals?.count?totals.weightG:undefined);data.cost=totals?.cost??undefined;data.purchasePrice=totals?.purchasePrice??undefined;}
 if(status==='verified'&&existing?.status!=='verified'){if(!existing)throw new BadRequestException('先保存独立定义和商品组成再验证');const probe=Object.assign(new ResourceRecord(),existing,{data}),report=await buildSnapshot(em,user.companyId,probe);if(report.issues.length)throw new BadRequestException(report.issues.map(issue=>issue.message).join('；'));if(!(Number(data.weightG)>0)||totals?.cost==null)throw new BadRequestException('验证前组成必须有完整成本和重量');data.snapshot=JSON.stringify(report.snapshot);data.signature=report.signature;data.verifiedAt=new Date().toISOString().slice(0,10);}else if(status!=='verified'){delete data.signature;delete data.verifiedAt;if(status==='pending')delete data.snapshot;}
 await guardReferenced(em,user,existing,data,status);return true;
}
export async function beginIndependentBaseForm(em:EntityManager,user:AuthUser){await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});beginBaseCodeForm(em);}
export async function finishIndependentBaseForm(host:RuleHost,em:EntityManager,user:AuthUser,record:ResourceRecord,markBundles:(id:number)=>Promise<void>){endBaseCodeForm(em);if(record.data.origin!=='composed')return;if(!record.data.codeDictionaryCategoryId)await seedMainLine(host,em,user,record);await afterBaseCodeLineChange({em,host,user},record.id,markBundles);const rows=await host.findWhere(em,user.companyId,'finance-base-code-lines','baseCodeId',record.id),mains=rows.filter(row=>row.data.role==='main').length,warnings:string[]=[];if(!rows.length)warnings.push('尚未添加商品组成');else if(!mains)warnings.push('尚未指定主要商品档案');else if(mains>1)warnings.push('当前指定了多个主要商品档案，建议保留一个');await host.patchData(em,user,'finance-base-codes',record.id,{definitionWarnings:JSON.stringify(warnings)},'记录商品组成核对提示');}
