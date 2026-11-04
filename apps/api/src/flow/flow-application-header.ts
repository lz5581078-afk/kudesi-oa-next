import {BadRequestException,ConflictException,NotFoundException} from '@nestjs/common';
import {createHash} from 'crypto';
import {EntityManager} from 'typeorm';
import type {StepDef} from '@kudesi/shared';
import type {AuthUser} from '../common/auth.decorators';
import {CryptoService} from '../common/crypto.service';
import {FormDraft} from '../entities';
/** Internal encrypted header only; all item state remains in FlowRun/Step/Event. */
export const APPLICATION_HEADER_PREFIX='flow-application:';
export interface ApplicationHeaderData {definitionId:number;definitionVersion:number;steps:StepDef[];escalateUserIds:number[];shared:Record<string,unknown>;revision:number;createHash:string}
export interface ApplicationHeader {row:FormDraft;data:ApplicationHeaderData;version:string}
export const applicationHeaderModule=(key:string)=>`${APPLICATION_HEADER_PREFIX}${key}`;
export const applicationHeaderVersion=(row:FormDraft)=>createHash('sha256').update(JSON.stringify([row.id,row.title,row.payload,row.sourceRecordId])).digest('hex');
export class FlowApplicationHeaderStore {
 constructor(private readonly crypto:CryptoService){}
 async read(em:EntityManager,user:AuthUser,key:string,ref:string,lock=false):Promise<ApplicationHeader>{
  const row=await em.findOne(FormDraft,{where:{companyId:user.companyId,moduleKey:applicationHeaderModule(key),sourceRecordId:ref},...(lock?{lock:{mode:'pessimistic_write' as const}}:{})});
  if(!row)throw new NotFoundException('申请单不存在');
  return {row,data:this.decode(row),version:applicationHeaderVersion(row)};
 }
 private decode(row:FormDraft):ApplicationHeaderData{
  if(typeof row.payload.__encryptedDraft!=='string')throw new BadRequestException('申请索引缺少可信加密资料');
  return JSON.parse(this.crypto.decrypt(row.payload.__encryptedDraft)) as ApplicationHeaderData;
 }
 async create(em:EntityManager,user:AuthUser,key:string,ref:string,title:string,data:ApplicationHeaderData){
  const moduleKey=applicationHeaderModule(key),row=await em.save(FormDraft,em.create(FormDraft,{companyId:user.companyId,userId:user.id,moduleKey,draftKey:`${encodeURIComponent(moduleKey)}:${ref}`,sourceRecordId:ref,title,payload:{__encryptedDraft:this.crypto.encrypt(JSON.stringify(data))}}));
  return {row,data,version:applicationHeaderVersion(row)};
 }
 async save(em:EntityManager,header:ApplicationHeader,expected?:string){
  if(expected!==undefined&&header.version!==expected)throw new ConflictException('申请公共资料或规格已变化，请刷新后重试');
  header.data.revision++;header.row.payload={__encryptedDraft:this.crypto.encrypt(JSON.stringify(header.data))};await em.save(FormDraft,header.row);header.version=applicationHeaderVersion(header.row);return header;
 }
 assertVersion(header:ApplicationHeader,version:string){if(!version||version!==header.version)throw new ConflictException('申请公共资料或规格已变化，请刷新后重试');}
}
