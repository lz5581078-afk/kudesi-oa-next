import 'reflect-metadata';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { addDaysText, todayShanghai } from '@kudesi/shared';
import { buildDataSourceOptions } from '../database/data-source';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, Company, PlatformAdmin, User, Position, PositionPermission, UserPermissionOverride, ResourceRecord } from '../entities';
import { OrgAdminService } from '../org/org-admin.service';
import { buildServices } from '../test-support';
import { AuthService } from '../auth/auth.service';
import { WorkforceLoginService } from './workforce-login.service';
import { workforceBlockFor } from './workforce-contract';

const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('兼职临时工账号与密码（真实数据库）',()=>{
  let ds:DataSource,login:WorkforceLoginService,admin:OrgAdminService,actor:AuthUser,foreign:AuthUser;
  let resources:ReturnType<typeof buildServices>['resources'];
  const account=()=>`wf${randomBytes(8).toString('hex')}`;
  const password='Fixture-123!';
  beforeAll(async()=>{
    ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_workforce_login_test'}),migrationsRun:true} as never);await ds.initialize();
    const company=await ds.manager.save(Company,ds.manager.create(Company,{code:account(),name:'用工登录测试',status:'active'}));
    const u=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:account(),passwordHash:'!test-only',name:'管理',status:'active',isCompanyAdmin:true,mustChangePassword:false}));
    actor={id:u.id,companyId:company.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:account(),name:'其他公司',status:'active'}));foreign={...actor,companyId:c.id};
    admin=new OrgAdminService(ds);login=new WorkforceLoginService(ds,admin);resources=buildServices(ds).resources;
  },30000);
  afterAll(async()=>{await ds?.destroy();});
  async function filed(type:'part_time'|'temp'='part_time') {
    const created=await login.create(actor,{account:account(),name:'兼职测试',employmentType:type,password});
    const record=await resources.create(actor,'workforce',{userId:created.staff.id,employmentType:type,contractStartDate:addDaysText(todayShanghai(),-2),...(type==='temp'?{contractEndDate:addDaysText(todayShanghai(),2)}:{})});
    return {created,record};
  }
  it('两类用工可以自设或生成密码，保持用户ID且默认首次登录必须改密',async()=>{
    const part=await filed();expect(part.created.initialPassword).toBe(password);
    const row=await ds.manager.findOneByOrFail(User,{id:part.created.staff.id});expect(row.employmentType).toBe('part_time');expect(row.mustChangePassword).toBe(true);expect(await bcrypt.compare(password,row.passwordHash)).toBe(true);
    const generated=await login.create(actor,{account:account(),name:'临时工',employmentType:'temp'});expect(generated.initialPassword).toHaveLength(12);
    const temp=await ds.manager.findOneByOrFail(User,{id:generated.staff.id});expect(await bcrypt.compare(generated.initialPassword,temp.passwordHash)).toBe(true);
    const logs=await ds.manager.find(AuditLog,{where:{companyId:actor.companyId}});expect(JSON.stringify(logs)).not.toContain(password);
    await expect(login.create(actor,{account:account(),name:'错误',employmentType:'regular' as never})).rejects.toThrow(/兼职或临时工/);
  });
  it('修改登录账号和密码后用新凭据登录，原凭据失败；空密码字段缺省保持原密码',async()=>{
    const {created,record}=await filed('temp');const next=account();
    const row=await ds.manager.findOneByOrFail(User,{id:created.staff.id});
    await login.update(actor,record.id,{account:next});expect((await ds.manager.findOneByOrFail(User,{id:row.id})).passwordHash).toBe(row.passwordHash);
    const nextPassword='Updated-987!';await login.update(actor,record.id,{account:next,password:nextPassword});
    const changed=await ds.manager.findOneByOrFail(User,{id:row.id});expect(changed.id).toBe(row.id);expect(changed.employmentType).toBe('temp');expect(await bcrypt.compare(nextPassword,changed.passwordHash)).toBe(true);expect(changed.status).toBe(row.status);
    expect((await resources.get(actor,'workforce',record.id)).data.account).toBe(next);
    const auth=new AuthService({signAsync:async()=>'test-token'} as never,ds.getRepository(Company),ds.getRepository(PlatformAdmin),ds.getRepository(User),ds.getRepository(Position),ds.getRepository(PositionPermission),ds.getRepository(UserPermissionOverride),ds.getRepository(AuditLog),{isBound:async()=>true} as never);
    await expect(auth.login(created.staff.account,password)).rejects.toThrow();await expect(auth.login(next,password)).rejects.toThrow();expect((await auth.login(next,nextPassword)).type).toBe('company');
    const logs=await ds.manager.find(AuditLog,{where:{companyId:actor.companyId,action:'user.workforce_login.update'}});expect(JSON.stringify(logs)).not.toContain(nextPassword);expect(JSON.stringify(logs)).not.toContain(changed.passwordHash);
  });
  it('权限分别校验：无资料修改/员工修改不能设置，无重置权限只能改账号',async()=>{
    const {created,record}=await filed();const limited=(allow:string[])=>({...actor,permissions:{isCompanyAdmin:false,allow,deny:[]}});
    await expect(login.create(limited(['resource.workforce.create']),{account:account(),name:'甲',employmentType:'temp'})).rejects.toThrow(/权限/);
    await expect(login.update(limited(['org.staff.edit']),record.id,{account:account()})).rejects.toThrow(/权限/);
    await expect(login.update(limited(['resource.workforce.edit','org.staff.edit']),record.id,{account:created.staff.account,password:'Changed-123!'})).rejects.toThrow(/密码的权限/);
    await expect(login.update(limited(['resource.workforce.edit','org.staff.edit']),record.id,{account:account()})).resolves.toMatchObject({ok:true});
  });
  it('跨公司、普通员工、归档及密码不合法均拒绝，冲突不修改原密码',async()=>{
    const {created,record}=await filed();await expect(login.update(foreign,record.id,{account:account()})).rejects.toThrow(/不存在/);
    await expect(login.update(actor,record.id,{account:created.staff.account,password:'short'})).rejects.toThrow(/至少8位/);
    await expect(login.update(actor,record.id,{account:created.staff.account,password:'汉'.repeat(25)})).rejects.toThrow(/72字节/);
    const original=await ds.manager.findOneByOrFail(User,{id:created.staff.id});await expect(login.update(actor,record.id,{account:(await admin.getStaff(actor,actor.id)).account,password:'Changed-123!'})).rejects.toThrow(/已经存在/);
    expect((await ds.manager.findOneByOrFail(User,{id:original.id})).passwordHash).toBe(original.passwordHash);
    await ds.manager.update(User,{id:created.staff.id},{employmentType:'regular'});await expect(login.update(actor,record.id,{account:account()})).rejects.toThrow(/有效/);
    await ds.manager.update(User,{id:created.staff.id},{employmentType:'part_time'});await ds.manager.update(ResourceRecord,{id:record.id},{archivedAt:new Date()});await expect(login.update(actor,record.id,{account:account()})).rejects.toThrow(/不存在/);
  });
  it('已有无登录账号人员可设置，合作期限和停用限制仍然生效',async()=>{
    const {created,record}=await filed();await ds.manager.update(User,{id:created.staff.id},{account:null});
    const next=account();await login.update(actor,record.id,{account:next,password:'New-Password9'});expect((await ds.manager.findOneByOrFail(User,{id:created.staff.id})).account).toBe(next);
    await resources.update(actor,'workforce',record.id,{contractEndDate:addDaysText(todayShanghai(),-1)});
    const user=await ds.manager.findOneByOrFail(User,{id:created.staff.id});expect(await workforceBlockFor(ds.manager,user)).toMatch(/结束/);
    await ds.manager.update(User,{id:user.id},{status:'disabled'});await login.update(actor,record.id,{account:next,password:'Another-987'});expect((await ds.manager.findOneByOrFail(User,{id:user.id})).status).toBe('disabled');
  });
  it('多个用工账号不能同时改为同一个全局账号',async()=>{
    const a=await filed(),b=await filed();const same=account();
    const result=await Promise.allSettled([login.update(actor,a.record.id,{account:same}),login.update(actor,b.record.id,{account:same})]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(result.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect(await ds.manager.count(User,{where:{account:same}})).toBe(1);
  });
});
