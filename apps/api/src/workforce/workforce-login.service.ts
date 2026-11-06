import { storeWorkforcePassword, validateWorkforcePassword } from './workforce-password';
import { CryptoService } from '../common/crypto.service';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { createChecker } from '@kudesi/shared';
import { accountTransaction } from '../auth/account-transaction';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, PlatformAdmin, ResourceRecord, User } from '../entities';
import { OrgAdminService } from '../org/org-admin.service';

export interface WorkforceAccountInput { account:string; name:string; employmentType:'part_time'|'temp'; password?:string; departmentId?:number|null; positionId?:number|null }
@Injectable()
export class WorkforceLoginService {
  constructor(@InjectDataSource() private readonly ds:DataSource, private readonly admin:OrgAdminService, private readonly crypto:CryptoService) {}
  private account(value:string) {
    const account=value.trim();
    if(!/^[A-Za-z0-9_.-]{2,64}$/.test(account))throw new BadRequestException('账号只能用字母、数字、下划线、点和横线，2 到 64 位');
    return account;
  }
  private password(value: string | undefined) {
    if (value !== undefined) validateWorkforcePassword(value);
    return value;
  }
  async display(actor:AuthUser,ids:number[]) {
    const can=createChecker(actor.permissions);
    if(!can('resource.workforce.view'))throw new ForbiddenException();
    if(!ids.length)return [];
    const people=await this.ds.manager.find(User,{where:{companyId:actor.companyId,id:In(ids),employmentType:In(['part_time','temp']),isCompanyAdmin:false}});
    const bindings: Array<{user_id:number}> = people.length ? await this.ds.query(
      'SELECT DISTINCT user_id FROM feishu_identities WHERE company_id=? AND user_id IN (?)',
      [actor.companyId, people.map(person => person.id)],
    ) : [];
    const boundIds = new Set(bindings.map(row => Number(row.user_id)));
    const allowed=can('org.staff.reset');
    const secrets: Array<{user_id:number;password_cipher:string;password_hash_snapshot:string}>=allowed?await this.ds.query('SELECT user_id,password_cipher,password_hash_snapshot FROM workforce_login_secrets WHERE company_id=? AND user_id IN (?)',[actor.companyId,people.map(p=>p.id).length?people.map(p=>p.id):[0]]):[];
    const revealed:number[]=[];
    const result=people.map(person=>{
      const secret=secrets.find(s=>Number(s.user_id)===person.id&&s.password_hash_snapshot===person.passwordHash);
      const password=secret?this.crypto.decrypt(secret.password_cipher):undefined;
      if(password!==undefined)revealed.push(person.id);
      return {id:person.id,account:person.account,feishuBound:boundIds.has(person.id),...(allowed?{loginPassword:password??(person.passwordHash&&!person.passwordHash.startsWith('!')?'历史密码不可读取，可重新设置':'未设置')}:{})};
    });
    if(revealed.length)await this.ds.manager.save(AuditLog,this.ds.manager.create(AuditLog,{companyId:actor.companyId,actorId:actor.id,action:'user.workforce_password.view',resourceType:'user',resourceId:null,detail:{userIds:revealed}}));
    return result;
  }
  async create(actor:AuthUser,input:WorkforceAccountInput) {
    const can=createChecker(actor.permissions);
    if(!can('resource.workforce.create')||!can('org.staff.create'))throw new ForbiddenException('没有新增兼职与临时工账号的权限');
    if(!['part_time','temp'].includes(input.employmentType))throw new BadRequestException('这里只能新增兼职或临时工');
    if(!input.name.trim())throw new BadRequestException('请填写姓名');
    const account=this.account(input.account),password=this.password(input.password);
    const {password:_,...staff}=input;
    return this.admin.createStaff(actor,{...staff,account},password,(em,person,plain)=>storeWorkforcePassword(em,this.crypto,actor,person,plain));
  }
  async update(actor:AuthUser,id:number,input:{account:string;password?:string},unfiled=false) {
    const can=createChecker(actor.permissions);
    if(!can('resource.workforce.edit')||!can('org.staff.edit'))throw new ForbiddenException('没有设置兼职与临时工登录账号的权限');
    if(input.password!==undefined&&!can('org.staff.reset'))throw new ForbiddenException('没有设置登录密码的权限');
    const account=this.account(input.account),password=this.password(input.password);
    const hash=password===undefined?undefined:await bcrypt.hash(password,10);
    return accountTransaction(this.ds,account,async em=>{
      const record=unfiled?null:await em.findOne(ResourceRecord,{where:{id,companyId:actor.companyId,type:'workforce'},lock:{mode:'pessimistic_write'}});
      if(!unfiled&&(!record||record.archivedAt))throw new NotFoundException('兼职与临时工档案不存在');
      const userId=unfiled?id:Number(record!.data.userId);
      const person=await em.findOne(User,{where:{id:userId,companyId:actor.companyId},lock:{mode:'pessimistic_write'}});
      if(!person||person.isCompanyAdmin||!['part_time','temp'].includes(person.employmentType))throw new BadRequestException('该档案不是有效的兼职或临时工账号');
      if(unfiled) {
        const filed=await em.createQueryBuilder(ResourceRecord,'r').where("r.company_id=:companyId AND r.type='workforce'",{companyId:actor.companyId}).andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data,'$.userId'))=:userId",{userId:String(person.id)}).getOne();
        if(filed)throw new ConflictException('该人员已有用工档案，请刷新后从档案设置账号');
      }
      const duplicate=await em.findOne(User,{where:{account}});
      if((duplicate&&duplicate.id!==person.id)||await em.findOne(PlatformAdmin,{where:{account}}))throw new ConflictException('这个账号已经存在，请换一个');
      const before=person.account;
      person.account=account;
      if(hash!==undefined){person.passwordHash=hash;person.mustChangePassword=true;}
      await em.save(person);
      // Keep searchable account snapshot consistent; derived views continue reading the same user ID.
      if(record){record.data={...record.data,account};await em.save(record);}
      if(password!==undefined)await storeWorkforcePassword(em,this.crypto,actor,person,password);
      await em.save(AuditLog,em.create(AuditLog,{companyId:actor.companyId,actorId:actor.id,action:'user.workforce_login.update',resourceType:'user',resourceId:String(person.id),detail:{...(unfiled?{}:{recordId:id}),accountFrom:before,accountTo:account,passwordChanged:hash!==undefined}}));
      return {ok:true,account};
    });
  }
}
