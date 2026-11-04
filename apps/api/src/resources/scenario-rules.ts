import {BadRequestException,ForbiddenException} from '@nestjs/common';
import {createHash} from 'crypto';
import {Company,ResourceRecord} from '../entities';
import type {BeforeSaveContext} from './resource-rules';
/** 原销售场景名称入口：沿统一资源规则生成稳定标识，停用仍保留原事实。 */
export async function beforeSalesScenario({em,user,data,existing,status,host}:BeforeSaveContext){
 await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
 const name=String(data.name??'').trim();data.name=name;
 let code=String(data.code??'').trim();
 if(!code){if(!user.permissions.isCompanyAdmin)throw new ForbiddenException('只有公司管理员能新增销售场景');const hash=createHash('sha256').update(name).digest('hex').slice(0,12);code='scene_'+hash;data.segment='S'+hash.toUpperCase();}
 data.code=code;
 if(existing&&String(existing.data.code).toLowerCase()==='standard'&&status!=='active')throw new BadRequestException('默认公司自销场景不能停用');
 if(existing&&existing.status==='active'&&status!=='active'&&(await host.findWhere(em,user.companyId,'finance-bundles','scenarioId',existing.id)).length)throw new BadRequestException('该场景已有组合编码使用，不能停用');
 const rows=await em.createQueryBuilder(ResourceRecord,'r').where('r.companyId=:companyId AND r.type=:type',{companyId:user.companyId,type:'finance-scenarios'}).orderBy('r.id','ASC').setLock('pessimistic_read').getMany();
 if(!existing||name!==existing.data.name||String(data.segment??'')!==String(existing.data.segment??'')){
  const duplicate=rows.find(row=>row.id!==existing?.id&&(String(row.data.name).trim()===name||String(data.segment??'')!==''&&String(row.data.segment??'')===String(data.segment)));
  if(duplicate)throw new BadRequestException('场景名称或编码标识重复');
 }
}
