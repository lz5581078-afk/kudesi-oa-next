import { BadRequestException, ConflictException } from '@nestjs/common';
import { ARCHIVE_TYPE_CODE } from '@kudesi/shared';
import { EntityManager, IsNull } from 'typeorm';
import { ResourceRecord } from '../entities';
import type { BeforeSaveContext } from './resource-rules';

const TYPE='finance-archive-prefixes';
export async function archiveCodePrefix(em:EntityManager, companyId:number, archiveType:string) {
 const r=await em.findOne(ResourceRecord,{where:{companyId,type:TYPE,uniqueKey:archiveType.toLowerCase(),archivedAt:IsNull()}});
 return String(r?.data.code || ARCHIVE_TYPE_CODE[archiveType] || archiveType.replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,8) || 'XX');
}
export async function beforeArchivePrefix({em,user,data,existing}:BeforeSaveContext) {
 const family=String(data.archiveType ?? '');
 if (existing && family!==existing.data.archiveType) throw new BadRequestException('档案类型不能修改');
 const custom=await em.find(ResourceRecord,{where:{companyId:user.companyId,type:'finance-product-units',archivedAt:IsNull()}});
 const customTypes=custom.filter(r=>r.data.kind==='archive_type').map(r=>String(r.data.code));
 if (!Object.hasOwn(ARCHIVE_TYPE_CODE,family)&&!customTypes.includes(family)) throw new BadRequestException('档案类型不存在');
 const code=String(data.code||'').trim().toUpperCase();
 if(!/^[A-Z0-9]{1,8}$/.test(code))throw new BadRequestException('类型编号必须为1～8位英文字母或数字');
 const settings=await em.find(ResourceRecord,{where:{companyId:user.companyId,type:TYPE,archivedAt:IsNull()}});
 const configured=new Map(settings.map(r=>[String(r.data.archiveType),String(r.data.code)]));
 for(const key of new Set([...Object.keys(ARCHIVE_TYPE_CODE),...customTypes])) {
  if(key===family)continue;
  if((configured.get(key)||ARCHIVE_TYPE_CODE[key]||key.toUpperCase().slice(0,8))===code)throw new ConflictException(`类型编号 ${code} 已被其他档案类型使用`);
 }
 data.code=code;
}
