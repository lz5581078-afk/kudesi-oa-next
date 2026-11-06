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
import { createTrialPerson } from './create-trial-person';
import { livePeople } from '../live/live-access';

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
    const services = buildServices(ds);
    resources = services.resources;
    admin = new OrgAdminService(ds, resources, services.crypto);
    login = new WorkforceLoginService(ds, admin, services.crypto);
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
  it('未来密码加密保存，仅密码管理员可读取，改密后旧明文失效且审计不含秘密',async()=>{
    const {created,record}=await filed();
    await expect(login.update(actor,created.staff.id,{account:account()},true)).rejects.toThrow(/已有用工档案/);
    const [stored]=await ds.query('SELECT * FROM workforce_login_secrets WHERE company_id=? AND user_id=?',[actor.companyId,created.staff.id]);
    expect(stored.password_cipher).not.toContain(password);
    expect((await login.display(actor,[created.staff.id]))[0].loginPassword).toBe(password);
    const viewer={...actor,permissions:{isCompanyAdmin:false,allow:['resource.workforce.view'],deny:[]}};
    expect((await login.display(viewer,[created.staff.id]))[0]).not.toHaveProperty('loginPassword');
    expect(await login.display(foreign,[created.staff.id])).toEqual([]);
    await ds.manager.update(User,{id:created.staff.id},{passwordHash:await bcrypt.hash('Self-changed-123',10)});
    expect((await login.display(actor,[created.staff.id]))[0].loginPassword).toMatch(/历史密码不可读取/);
    await login.update(actor,record.id,{account:created.staff.account!,password:'Future-password-321'});
    expect((await login.display(actor,[created.staff.id]))[0].loginPassword).toBe('Future-password-321');
    const logs=await ds.manager.find(AuditLog,{where:{companyId:actor.companyId,action:'user.workforce_password.view'}});
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(password);expect(JSON.stringify(logs)).not.toContain('Future-password-321');
    expect(JSON.stringify(await resources.list(actor,'workforce',{}))).not.toContain('Future-password-321');
  });
  it('未建档试播人员可设置账号，保留身份和直播试播标志',async()=>{
    const person=await ds.manager.save(User,ds.manager.create(User,{companyId:actor.companyId,account:null,passwordHash:'!no-login',name:'试播测试',employmentType:'part_time',status:'active',isCompanyAdmin:false,mustChangePassword:false}));
    await ds.query('UPDATE users SET live_trial=1 WHERE company_id=? AND id=?',[actor.companyId,person.id]);
    const beforeCount=await ds.manager.count(ResourceRecord,{where:{companyId:actor.companyId,type:'workforce'}});
    expect((await login.display(actor,[person.id]))[0].loginPassword).toBe('未设置');
    const next=account();await login.update(actor,person.id,{account:next,password:'Trial-password-321'},true);
    const [updated]=await ds.query('SELECT live_trial FROM users WHERE company_id=? AND id=?',[actor.companyId,person.id]);expect(updated.live_trial).toBe(1);
    expect((await login.display(actor,[person.id]))[0]).toMatchObject({account:next,loginPassword:'Trial-password-321'});
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:actor.companyId,type:'workforce'}})).toBe(beforeCount);
    await expect(login.update(foreign,person.id,{account:account()},true)).rejects.toThrow();
  });

  it('同一员工编辑原子建立账号、建档及退出试播，旧的已建档试播标记也按普通主播读取', async () => {
    const trial = await createTrialPerson(ds, actor, { name: '仅姓名试播主播' });
    const position = await ds.manager.save(Position, ds.manager.create(Position, {
      companyId: actor.companyId, name: '测试主播岗', workspaceType: 'live_anchor', status: 'active',
    }));
    expect((await livePeople(ds.manager, actor.companyId)).anchors.find(person => person.id === trial.id)?.trial).toBe(true);
    const input = {
      account: account(), password: 'Local-password-791', name: '主播已建档', positionId: position.id,
      employmentType: 'part_time' as const, contractStartDate: todayShanghai(),
      workforceData: { phone: '13900000001', payMethod: 'hourly', payRate: 4000, note: '原人员补齐档案' },
    };
    await expect(admin.updateStaff(actor, trial.id, { ...input, positionId: null })).rejects.toThrow('请设置主播岗位');
    expect((await admin.getStaff(actor, trial.id))).toMatchObject({ account: '', workforceId: null, trial: true });
    const updated = await admin.updateStaff(actor, trial.id, input);
    expect(updated).toMatchObject({ id: trial.id, trial: false, account: input.account, hourlyRate: 4000 });
    expect(updated.workforceId).toBeGreaterThan(0);
    expect((await resources.get(actor, 'workforce', updated.workforceId!)).data).toMatchObject({
      userId: trial.id, phone: '13900000001', payRate: 4000,
    });
    const [saved] = await ds.query('SELECT live_trial,password_hash FROM users WHERE company_id=? AND id=?', [actor.companyId, trial.id]);
    expect(saved.live_trial).toBe(0);
    expect(await bcrypt.compare(input.password, saved.password_hash)).toBe(true);
    const logs = await ds.manager.find(AuditLog, { where: { companyId: actor.companyId, resourceId: String(trial.id) } });
    expect(JSON.stringify(logs)).not.toContain(input.password);

    await ds.query('UPDATE users SET live_trial=1 WHERE company_id=? AND id=?', [actor.companyId, trial.id]);
    expect((await livePeople(ds.manager, actor.companyId)).anchors.find(person => person.id === trial.id)).toMatchObject({ name: '主播已建档', partTime: true });
    expect((await admin.getStaff(actor, trial.id)).trial).toBe(false);
  });

});
