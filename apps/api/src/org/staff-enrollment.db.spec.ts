import { todayShanghai } from '@kudesi/shared';
import { ExternalConfigService } from '../integrations/external-config.service';
import { buildServices } from '../test-support';
import { FeishuBindingPolicy } from '../auth/feishu-binding-policy';
import 'reflect-metadata';
import { randomBytes, createHash } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, Company, Department, PlatformAdmin, Position, PositionPermission, ResourceRecord, User, UserPermissionOverride } from '../entities';
import { AuthService } from '../auth/auth.service';
import { OrgAdminService } from './org-admin.service';
import { StaffEnrollmentInvite } from './staff-enrollment.entity';
import { StaffEnrollmentService } from './staff-enrollment.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('员工扫码入职：真实 MySQL', () => {
  let ds: DataSource, svc: StaffEnrollmentService, org: OrgAdminService;
  let a: AuthUser, b: AuthUser, job: Position, foreign: Position, department: Department;
  const password = 'enrollment-test-only';
  const phone = () => '139' + String(BigInt('0x' + randomBytes(6).toString('hex')) % 100000000n).padStart(8, '0');
  const input = (token: string, extra: object = {}) => ({ token, name: '新人', phone: phone(), password, ...extra });
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true } as never);
    await ds.initialize(); svc = new StaffEnrollmentService(ds, buildServices(ds).resources); org = new OrgAdminService(ds);
    async function actor() {
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: randomBytes(8).toString('hex'), name: '扫码测试', status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, name: '人事', account: randomBytes(10).toString('hex'), passwordHash: 'x', status: 'active', isCompanyAdmin: true, mustChangePassword: false }));
      return { id: u.id, companyId: c.id, name: u.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser;
    }
    a = await actor(); b = await actor();
    department = await ds.manager.save(Department, ds.manager.create(Department, { companyId: a.companyId, name: '运营部', status: 'active', sortOrder: 0 }));
    const p = await org.createPosition(a, { name: '运营', departmentId: department.id, workspaceType: 'operations' });
    job = await ds.manager.findOneByOrFail(Position, { id: p.id });
    foreign = await ds.manager.findOneByOrFail(Position, { id: (await org.createPosition(b, { name: '他司岗位', workspaceType: 'blank' })).id });
    await org.setPositionPermissions(a, job.id, ['resource.stores.view']);
  });
  afterAll(async () => { await ds?.destroy(); });
  it('通用码只列本公司启用岗位；令牌仅存摘要，列表无令牌', async () => {
    const inactive = await org.createPosition(a, { name: '停用岗', workspaceType: 'blank' });
    await ds.manager.update(Position, inactive.id, { status: 'inactive' });
    const r = await svc.create(a, { mode: 'general' });
    const preview = await svc.preview(r.token);
    expect(preview.positions.map(p => p.id)).toEqual([job.id]);
    expect(preview.position).toBeNull();
    const stored = await ds.getRepository(StaffEnrollmentInvite).createQueryBuilder('i').addSelect('i.tokenHash').where('i.id = :id', { id: r.id }).getOneOrFail();
    expect(stored.tokenHash).toBe(createHash('sha256').update(r.token).digest('hex'));
    expect(JSON.stringify(await svc.list(a))).not.toContain(r.token);
    await expect(svc.join(input(r.token))).rejects.toThrow('请选择岗位');
    await expect(svc.join(input(r.token, { positionId: foreign.id }))).rejects.toThrow('岗位已停用或不存在');
    const submitted = input(r.token, { positionId: job.id });
    await svc.join(submitted);
    const u = await ds.manager.findOneByOrFail(User, { account: submitted.phone });
    expect(u).toMatchObject({ companyId: a.companyId, positionId: job.id, departmentId: department.id, isCompanyAdmin: false, mustChangePassword: false, name: '新人' });
    expect(await bcrypt.compare(password, u.passwordHash)).toBe(true);
    const auth = new AuthService(new JwtService({ secret: randomBytes(48).toString('hex') }), ds.getRepository(Company), ds.getRepository(PlatformAdmin), ds.getRepository(User), ds.getRepository(Position), ds.getRepository(PositionPermission), ds.getRepository(UserPermissionOverride), ds.getRepository(AuditLog), new FeishuBindingPolicy(new ExternalConfigService(ds, buildServices(ds).crypto)));
    const login = await auth.login(submitted.phone, password);
    expect(login.type).toBe('company');
    if (login.type === 'company') expect(login.user.permissions.allow).toContain('resource.stores.view');
    await expect(svc.join(submitted)).rejects.toThrow('该手机号暂不能注册');
  });
  it('岗位码无需提交岗位，篡改岗位被拒，二维码可供多名新人使用', async () => {
    const r = await svc.create(a, { mode: 'position', positionId: job.id });
    expect(await svc.preview(r.token)).toMatchObject({ mode: 'position', position: { id: job.id }, positions: [] });
    await expect(svc.join(input(r.token, { positionId: foreign.id }))).rejects.toThrow('不能更换');
    for (let i = 0; i < 2; i++) {
      const data = input(r.token); await svc.join(data);
      expect(await ds.manager.findOneBy(User, { account: data.phone })).toMatchObject({ positionId: job.id });
    }
  });
  it('生成/停用需人事权限且隔离公司；失效码不能预览和入职', async () => {
    const denied = { ...a, permissions: { isCompanyAdmin: false, allow: [], deny: [] } };
    await expect(svc.create(denied, { mode: 'general' })).rejects.toThrow('没有创建员工');
    await expect(svc.create(a, { mode: 'position', positionId: foreign.id })).rejects.toThrow();
    const r = await svc.create(a, { mode: 'general' });
    await expect(svc.revoke(b, r.id)).rejects.toThrow('没有这个');
    await svc.revoke(a, r.id);
    await expect(svc.preview(r.token)).rejects.toThrow('已失效');
    await expect(svc.join(input(r.token, { positionId: job.id }))).rejects.toThrow('已失效');
    const expired = await svc.create(a, { mode: 'general' });
    await ds.manager.update(StaffEnrollmentInvite, expired.id, { expiresAt: new Date(Date.now() - 60000) });
    await expect(svc.preview(expired.token)).rejects.toThrow('已失效');
    await expect(svc.preview('bad')).rejects.toThrow('无效');
  });
  it('长期码跨时间仍有效，同岗位换码后旧码失效且不影响其他岗位/公司/通用码',async()=>{
    const other=await org.createPosition(a,{name:'另一个岗位',workspaceType:'blank'});
    const first=await svc.create(a,{mode:'position',positionId:job.id,employmentType:'part_time'});
    const independent=await svc.create(a,{mode:'position',positionId:other.id});
    const general=await svc.create(a,{mode:'general'});
    const crossCompany=await svc.create(b,{mode:'position',positionId:foreign.id});
    expect(first.expiresAt).toBeNull();
    const now=jest.spyOn(Date,'now').mockReturnValue(Date.now()+3650*86400000);
    try{expect((await svc.preview(first.token)).expiresAt).toBeNull();}finally{now.mockRestore();}
    const replacement=await svc.create(a,{mode:'position',positionId:job.id,employmentType:'temp'});
    for(const token of [first.token]){await expect(svc.preview(token)).rejects.toThrow('已失效');await expect(svc.join(input(token))).rejects.toThrow('已失效');}
    for(const token of [replacement.token,independent.token,general.token,crossCompany.token])await expect(svc.preview(token)).resolves.toBeTruthy();
    const nextGeneral=await svc.create(a,{mode:'general'});await expect(svc.preview(general.token)).rejects.toThrow('已失效');await expect(svc.preview(nextGeneral.token)).resolves.toBeTruthy();
    const raced=await Promise.all([svc.create(a,{mode:'position',positionId:job.id}),svc.create(a,{mode:'position',positionId:job.id})]);
    expect((await svc.list(a)).filter(r=>r.mode==='position'&&r.positionId===job.id&&r.status==='active')).toHaveLength(1);
    expect((await Promise.allSettled(raced.map(r=>svc.preview(r.token)))).filter(r=>r.status==='fulfilled')).toHaveLength(1);
    await expect(svc.create(a,{mode:'position',positionId:foreign.id})).rejects.toThrow();
    expect((await svc.list(a)).filter(r=>r.mode==='position'&&r.positionId===job.id&&r.status==='active')).toHaveLength(1);
  });
  it('公司、发码人、岗位、部门停用后拒绝入职', async () => {
    const r = await svc.create(a, { mode: 'position', positionId: job.id });
    for (const [entity, id, inactive] of [[Company, a.companyId, 'suspended'], [User, a.id, 'disabled'], [Position, job.id, 'inactive'], [Department, department.id, 'inactive']] as const) {
      await ds.manager.update(entity as typeof Company, id, { status: inactive } as never);
      try { await expect(svc.join(input(r.token))).rejects.toThrow(); }
      finally { await ds.manager.update(entity as typeof Company, id, { status: 'active' }); }
    }
  });
  it.each(['part_time','temp'] as const)('岗位码按%s创建唯一账号和兼职临时工档案，保持岗位和手机号关联', async employmentType => {
    const r = await svc.create(a, {mode:'position',positionId:job.id,employmentType,contractStartDate:'2020-01-01',...(employmentType==='temp'?{contractEndDate:'2099-12-31'}:{})});
    expect(await svc.preview(r.token)).toMatchObject({employmentType,contractStartDate:null,contractEndDate:null,expiresAt:null});
    expect((await svc.list(a)).find(x=>x.id===r.id)?.employmentType).toBe(employmentType);
    const data=input(r.token); await svc.join(data);
    const u=await ds.manager.findOneByOrFail(User,{account:data.phone});
    expect(u.employmentType).toBe(employmentType); expect(u.positionId).toBe(job.id);
    const records=await ds.manager.find(ResourceRecord,{where:{companyId:a.companyId,type:'workforce'}});
    const mine=records.filter(r=>Number(r.data.userId)===u.id); expect(mine).toHaveLength(1);
    expect(mine[0].data).toMatchObject({userId:u.id,employmentType,phone:data.phone,contractStartDate:todayShanghai()});
    expect(mine[0].title).toBe(data.name); expect(mine[0].status).toBe('active');
    expect(mine[0].data.payRate).toBeUndefined();
  });
  it('正式员工码不创建兼职档案；旧码类型兼容正式',async()=>{
    const r=await svc.create(a,{mode:'position',positionId:job.id}); const data=input(r.token);await svc.join(data);
    const u=await ds.manager.findOneByOrFail(User,{account:data.phone});expect(u.employmentType).toBe('regular');
    expect((await ds.manager.find(ResourceRecord,{where:{companyId:a.companyId,type:'workforce'}})).some(r=>Number(r.data.userId)===u.id)).toBe(false);
  });
  it('拒绝非法用工类型，新码不再固化合作日期',async()=>{
    await expect(svc.create(a,{mode:'position',positionId:job.id,employmentType:'bad'} as never)).rejects.toThrow();
  });
  it('入职码合作期到期拒绝注册且不留下孤立账号',async()=>{
    const r=await svc.create(a,{mode:'position',positionId:job.id,employmentType:'temp',contractStartDate:'2020-01-01',contractEndDate:'2099-01-01'});
    await ds.manager.update(StaffEnrollmentInvite,r.id,{contractStartDate:'2020-01-01',contractEndDate:'2020-01-02'});
    const data=input(r.token);await expect(svc.join(data)).rejects.toThrow('合作期已结束');expect(await ds.manager.findOneBy(User,{account:data.phone})).toBeNull();
  });
  it('建档失败同事务回滚账号；公共提交不能自行更换用工类型',async()=>{
    const r=await svc.create(a,{mode:'position',positionId:job.id,employmentType:'part_time'});
    const data=input(r.token,{employmentType:'regular'}); await svc.join(data);
    expect((await ds.manager.findOneByOrFail(User,{account:data.phone})).employmentType).toBe('part_time');
    const resources=buildServices(ds).resources; const fail=jest.spyOn(resources,'createRecord').mockRejectedValueOnce(new Error('建档失败'));
    const isolated=new StaffEnrollmentService(ds,resources); const next=input(r.token);
    await expect(isolated.join(next)).rejects.toThrow('建档失败');expect(await ds.manager.findOneBy(User,{account:next.phone})).toBeNull();fail.mockRestore();
  });
  it('发码人失去建档权限后扫码被拒，账号不会单独创建',async()=>{
    const r=await svc.create(a,{mode:'position',positionId:job.id,employmentType:'part_time'});
    const data=input(r.token); await ds.manager.update(User,a.id,{isCompanyAdmin:false});
    try{await expect(svc.join(data)).rejects.toThrow('权限');expect(await ds.manager.findOneBy(User,{account:data.phone})).toBeNull();}
    finally{await ds.manager.update(User,a.id,{isCompanyAdmin:true});}
    const limited={...a,permissions:{isCompanyAdmin:false,allow:['org.staff.create'],deny:[]}} as AuthUser;
    await expect(svc.create(limited,{mode:'position',positionId:job.id,employmentType:'part_time'})).rejects.toThrow('没有创建兼职');
  });
  it('不同公司的码并发注册同一手机号仅创建一个账号；手工创建同样遵守全局唯一', async () => {
    const r = await svc.create(a, { mode: 'position', positionId: job.id });
    const s = await svc.create(b, { mode: 'position', positionId: foreign.id });
    const account = phone();
    const results = await Promise.allSettled([svc.join(input(r.token, { phone: account })), svc.join(input(s.token, { phone: account }))]);
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(await ds.manager.countBy(User, { account })).toBe(1);
    const second = phone();
    const raced = await Promise.allSettled([svc.join(input(r.token, { phone: second })), org.createStaff(b, { account: second, name: '手工' })]);
    expect(raced.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(await ds.manager.countBy(User, { account: second })).toBe(1);
    const adminPhone = phone();
    await ds.manager.save(PlatformAdmin, ds.manager.create(PlatformAdmin, { account: adminPhone, name: '平台', passwordHash: 'x', status: 'active' }));
    await expect(svc.join(input(r.token, { phone: adminPhone }))).rejects.toThrow('该手机号暂不能注册');
    const logs = await ds.manager.find(AuditLog, { where: { companyId: a.companyId, action: 'user.self-enroll' } });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(password);
    expect(JSON.stringify(logs)).not.toContain(r.token);
  });
});
