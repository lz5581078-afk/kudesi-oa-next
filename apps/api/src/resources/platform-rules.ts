import {BadRequestException} from '@nestjs/common';
import {EntityManager} from 'typeorm';
import {Company,ResourceRecord} from '../entities';
import type {BeforeSaveContext} from './resource-rules';
const text=(value:unknown)=>String(value??'').trim();
export async function platformReferences(em:EntityManager,companyId:number,platform:ResourceRecord){
 const rows=await em.find(ResourceRecord,{where:[{companyId,type:'finance-base-codes'},{companyId,type:'finance-bundles'}]});
 const code=text(platform.data.code).toUpperCase();
 return rows.filter(row=>Number(row.data.platformId)===platform.id||row.type==='finance-base-codes'&&code!==''&&text(row.data.styleCode).toUpperCase().split('-').includes(code));
}
export async function beforeSalesPlatform({em,user,data,existing,status}:BeforeSaveContext){
 await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
 const name=text(data.name),code=text(data.code).toUpperCase();data.name=name;data.code=code;
 if(!name||name.length>80)throw new BadRequestException('平台名称不能为空且不能超过80个字符');
 if((!existing||code!==text(existing.data.code))&&!/^[A-Z0-9]{1,16}$/.test(code))throw new BadRequestException('平台编码只能包含1至16位大写字母和数字');
 if(existing&&text(existing.data.code)==='GENERAL'&&(name!==existing.data.name||code!==existing.data.code||status!=='active'))throw new BadRequestException('通用为系统保留平台，不能修改或停用');
 const rows=await em.createQueryBuilder(ResourceRecord,'r').where('r.companyId=:companyId AND r.type=:type',{companyId:user.companyId,type:'finance-platforms'}).orderBy('r.id','ASC').setLock('pessimistic_read').getMany();
 if((!existing||name!==existing.data.name)&&rows.some(row=>row.id!==existing?.id&&text(row.data.name).toLocaleLowerCase('zh-CN')===name.toLocaleLowerCase('zh-CN')))throw new BadRequestException('平台名称或编码已存在');
 if(existing&&code!==text(existing.data.code)&&(await platformReferences(em,user.companyId,existing)).length)throw new BadRequestException('该平台已有业务引用，只能修改名称');
}
export async function beforePlatformDelete(em:EntityManager,companyId:number,record:ResourceRecord){
 await em.findOneOrFail(Company,{where:{id:companyId},lock:{mode:'pessimistic_write'}});
 if(text(record.data.code)==='GENERAL')throw new BadRequestException('通用为系统保留平台，不能删除');
 const count=(await platformReferences(em,companyId,record)).length;if(count)throw new BadRequestException(`该平台已被引用 ${count} 次，不能删除`);
}
