import {BadRequestException} from '@nestjs/common';
import {EntityManager} from 'typeorm';
import {ResourceRecord} from '../entities';
import type {RuleHost} from './resource-rules';
import {parseFieldList,parseOverrides,type NamingRule} from './bundle-naming';
const text=(v:unknown)=>typeof v==='string'?v:'';
export function namingRuleData(data:Record<string,unknown>):NamingRule{return{prefix:text(data.prefix),namePrefix:text(data.namePrefix),stylePrefix:text(data.stylePrefix),codeFields:parseFieldList(text(data.codeFields)),nameFields:parseFieldList(text(data.nameFields)),customCode:text(data.customCode),customName:text(data.customName),codeOverrides:parseOverrides(text(data.codeOverrides)),nameOverrides:parseOverrides(text(data.nameOverrides))};}
/** 来源编码分类是独立真实引用；从本级向父级找，不按名称连接旧档案树。 */
export async function codeCategoryNamingRule(host:RuleHost,em:EntityManager,companyId:number,categoryId:unknown):Promise<NamingRule|null>{
 if(typeof categoryId!=='number'||!Number.isSafeInteger(categoryId)||categoryId<=0)throw new BadRequestException('来源编码分类无效');
 const seen=new Set<number>();let id:number|undefined=categoryId;
 while(id!==undefined){if(seen.has(id)||seen.size>=4)throw new BadRequestException('来源编码分类父链无效');seen.add(id);
  const category:ResourceRecord|null=await em.findOne(ResourceRecord,{where:{companyId,type:'finance-code-dictionaries',id}});if(!category||category.archivedAt||category.status!=='active'||category.data.kind!=='product_category')throw new BadRequestException('来源类目不存在或已停用');
  const rule=await host.findByUnique(em,companyId,'finance-bundle-naming-rules','code-cat:'+id);if(rule)return namingRuleData(rule.data);
  const parent:unknown=category.data.parentId;if(parent==null)return null;if(typeof parent!=='number'||!Number.isSafeInteger(parent)||parent<=0)throw new BadRequestException('来源编码分类父链无效');id=parent;
 }
 return null;
}

export async function codeCategoryRuleSet(host:RuleHost,em:EntityManager,companyId:number,records:ResourceRecord[],strict:boolean){
 const rules:Record<number,NamingRule>={},cache=new Map<unknown,NamingRule|null>();
 for(const record of records){if(record.data.codeDictionaryCategoryId==null)continue;const id=record.data.codeDictionaryCategoryId;let rule=cache.get(id);if(rule===undefined){rule=await codeCategoryNamingRule(host,em,companyId,id);cache.set(id,rule);}if(!rule){if(strict)throw new BadRequestException(`${String(record.data.name||record.title)}：来源类目及上级未配置组合品编码规则`);continue;}rules[record.id]=rule;}
 return Object.keys(rules).length?rules:undefined;
}
