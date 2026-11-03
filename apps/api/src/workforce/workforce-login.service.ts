import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { createChecker } from '@kudesi/shared';
import { accountTransaction } from '../auth/account-transaction';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, PlatformAdmin, ResourceRecord, User } from '../entities';
import { OrgAdminService } from '../org/org-admin.service';

export interface WorkforceAccountInput { account:string; name:string; employmentType:'part_time'|'temp'; password?:string; departmentId?:number|null; positionId?:number|null }
@Injectable()
export class WorkforceLoginService {
  constructor(@InjectDataSource() private readonly ds:DataSource, private readonly admin:OrgAdminService) {}
  private account(value:string) {
    const account=value.trim();
    if(!/^[A-Za-z0-9_.-]{2,64}$/.test(account))throw new BadRequestException('账号只能用字母、数字、下划线、点和横线，2 到 64 位');
    return account;
  }
  private password(value:string|undefined) {
    // bcrypt only distinguishes the first 72 UTF-8 bytes. Never silently truncate a configured password.
    if(value!==undefined&&(typeof value!=='string'||value.length<8||Buffer.byteLength(value,'utf8')>72))throw new BadRequestException('密码至少8位，且不能超过72字节');
    return value;
  }
  async create(actor:AuthUser,input:WorkforceAccountInput) {
    const can=createChecker(actor.permissions);
    if(!can('resource.workforce.create')||!can('org.staff.create'))throw new ForbiddenException('没有新增兼职与临时工账号的权限');
    if(!['part_time','temp'].includes(input.employmentType))throw new BadRequestException('这里只能新增兼职或临时工');
    if(!input.name.trim())throw new BadRequestException('请填写姓名');
    const account=this.account(input.account),password=this.password(input.password);
    const {password:_,...staff}=input;
    return this.admin.createStaff(actor,{...staff,account},password);
  }
  async update(actor:AuthUser,id:number,input:{account:string;password?:string}) {
    const can=createChecker(actor.permissions);
    if(!can('resource.workforce.edit')||!can('org.staff.edit'))throw new ForbiddenException('没有设置兼职与临时工登录账号的权限');
    if(input.password!==undefined&&!can('org.staff.reset'))throw new ForbiddenException('没有设置登录密码的权限');
    const account=this.account(input.account),password=this.password(input.password);
    const hash=password===undefined?undefined:await bcrypt.hash(password,10);
    return accountTransaction(this.ds,account,async em=>{
      const record=await em.findOne(ResourceRecord,{where:{id,companyId:actor.companyId,type:'workforce'},lock:{mode:'pessimistic_write'}});
      if(!record||record.archivedAt)throw new NotFoundException('兼职与临时工档案不存在');
      const userId=Number(record.data.userId);
      const person=await em.findOne(User,{where:{id:userId,companyId:actor.companyId},lock:{mode:'pessimistic_write'}});
      if(!person||person.isCompanyAdmin||!['part_time','temp'].includes(person.employmentType))throw new BadRequestException('该档案不是有效的兼职或临时工账号');
      const duplicate=await em.findOne(User,{where:{account}});
      if((duplicate&&duplicate.id!==person.id)||await em.findOne(PlatformAdmin,{where:{account}}))throw new ConflictException('这个账号已经存在，请换一个');
      const before=person.account;
      person.account=account;
      if(hash!==undefined){person.passwordHash=hash;person.mustChangePassword=true;}
      await em.save(person);
      // Keep searchable account snapshot consistent; derived views continue reading the same user ID.
      record.data={...record.data,account};await em.save(record);
      await em.save(AuditLog,em.create(AuditLog,{companyId:actor.companyId,actorId:actor.id,action:'user.workforce_login.update',resourceType:'user',resourceId:String(person.id),detail:{recordId:id,accountFrom:before,accountTo:account,passwordChanged:hash!==undefined}}));
      return {ok:true,account};
    });
  }
}
