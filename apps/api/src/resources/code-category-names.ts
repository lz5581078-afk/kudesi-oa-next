import {ConflictException} from '@nestjs/common';
import {EntityManager} from 'typeorm';
import {Company,ResourceRecord} from '../entities';

const normalized=(value:unknown)=>String(value??'').normalize('NFKC').replace(/\s+/g,'').toLocaleLowerCase('zh-CN');
const isCodeCategory=(type:string,data:Record<string,unknown>)=>type==='finance-code-dictionaries'?data.kind==='product_category':type==='finance-categories'&&data.archiveType==='bundle';
/** 原两套编码分类共用名称空间；不改写旧归属或迫使无改名的旧资料迁移。两入口均沿公司锁→目录当前读；等待后不能沿用事务旧快照。 */
export async function assertCodeCategoryName(em:EntityManager,companyId:number,type:string,data:Record<string,unknown>,existing?:ResourceRecord|null){
  if(!isCodeCategory(type,data))return;
  await em.findOneOrFail(Company,{where:{id:companyId},lock:{mode:'pessimistic_write'}});
  const name=normalized(data.name);
  if(existing&&isCodeCategory(type,existing.data)&&normalized(existing.data.name)===name)return;
  const rows=await em.createQueryBuilder(ResourceRecord,'r')
    .where('r.companyId=:companyId',{companyId})
    .andWhere("((r.type='finance-code-dictionaries' AND JSON_UNQUOTE(JSON_EXTRACT(r.data,'$.kind'))='product_category') OR (r.type='finance-categories' AND JSON_UNQUOTE(JSON_EXTRACT(r.data,'$.archiveType'))='bundle'))")
    .orderBy('r.id','ASC').setLock('pessimistic_read').getMany();
  const conflict=rows.find(row=>row.id!==existing?.id&&isCodeCategory(row.type,row.data)&&normalized(row.data.name)===name);
  if(conflict)throw new ConflictException(`${conflict.type==='finance-code-dictionaries'?'商品编码':'商品组合编码'}分类中名称已存在：${String(conflict.data.name??conflict.title)}`);
}
