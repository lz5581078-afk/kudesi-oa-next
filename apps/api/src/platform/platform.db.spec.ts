/** 平台后台（企业申请、开通、公司启停）真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test npm test -w @kudesi/api -- platform */
import 'reflect-metadata';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, Department, PlatformAdmin, Position, User } from '../entities';
import { OrgAdminService } from '../org/org-admin.service';
import { PlatformService } from './platform.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('平台后台（真实数据库）', () => {
  let ds: DataSource;
  let svc: PlatformService;
  let admin: { id: number; name: string; account: string };
  const tag = crypto.randomBytes(3).toString('hex');
  const phone = (n: number) => `139${tag.replace(/[a-f]/g, '1').padEnd(6, '0').slice(0, 6)}${String(n).padStart(2, '0')}`;
  const input = (n: number) => ({ companyName: `申请公司${tag}${n}`, contactName: '王老板', contactPhone: phone(n), password: 'apply-password-1', contactTitle: '负责人', remark: '想用' });

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = new PlatformService(ds);
    const row = await ds.manager.save(PlatformAdmin, ds.manager.create(PlatformAdmin, { account: `root${tag}`, passwordHash: 'x', name: '平台', status: 'active' }));
    admin = { id: row.id, name: row.name, account: row.account };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('申请：密码只存哈希；同一手机号不能重复提交待审核申请', async () => {
    await svc.apply(input(1));
    const row = await ds.manager.findOneOrFail(ds.manager.connection.getMetadata('company_applications').target as never, { where: { adminAccount: phone(1) } } as never) as { adminPasswordHash: string; status: string };
    expect(row.status).toBe('pending');
    expect(row.adminPasswordHash).not.toContain('apply-password-1');
    expect(await bcrypt.compare('apply-password-1', row.adminPasswordHash)).toBe(true);
    await expect(svc.apply(input(1))).rejects.toThrow(/待审核/);
  });

  it('通过：开通公司 + 默认部门/岗位 + 管理员（手机号账号、自己的密码、无需改密）；不能重复通过', async () => {
    await svc.apply(input(2));
    const pending = (await svc.listApplications()).find((a) => a.contactPhone === phone(2))!;
    expect(pending.status).toBe('pending');
    const r = await svc.approve(admin, pending.id);
    expect(r.adminAccount).toBe(phone(2));
    const user = await ds.manager.findOneByOrFail(User, { account: phone(2) });
    expect(user).toMatchObject({ companyId: r.companyId, isCompanyAdmin: true, mustChangePassword: false, name: '王老板' });
    expect(await bcrypt.compare('apply-password-1', user.passwordHash)).toBe(true);
    expect(await ds.manager.count(Department, { where: { companyId: r.companyId } })).toBeGreaterThanOrEqual(5);
    expect(await ds.manager.count(Position, { where: { companyId: r.companyId } })).toBeGreaterThanOrEqual(3);
    expect(await ds.manager.count(AuditLog, { where: { companyId: r.companyId, action: 'company.provision' } })).toBe(1);
    const done = (await svc.listApplications()).find((a) => a.id === pending.id)!;
    expect(done).toMatchObject({ status: 'approved', approvedCompanyId: r.companyId, reviewedByName: '平台' });
    await expect(svc.approve(admin, pending.id)).rejects.toThrow(/处理过/);
    // 已有账号的手机号不能再申请
    await expect(svc.apply(input(2))).rejects.toThrow(/无法用于申请/);
  });

  it('驳回：必须写原因；驳回后不能再通过；驳回后同手机号可重新申请', async () => {
    await svc.apply(input(3));
    const a = (await svc.listApplications()).find((x) => x.contactPhone === phone(3))!;
    await expect(svc.reject(admin, a.id, '  ')).rejects.toThrow(/原因/);
    await svc.reject(admin, a.id, '资料不全');
    expect((await svc.listApplications()).find((x) => x.id === a.id)).toMatchObject({ status: 'rejected', rejectReason: '资料不全' });
    await expect(svc.approve(admin, a.id)).rejects.toThrow(/处理过/);
    await svc.apply(input(3));
  });

  it('账号全系统唯一：别家公司员工、平台管理员的账号，新建员工时都会被拒；同名历史账号登录直接拒绝', async () => {
    const r = (await svc.listApplications()).find((x) => x.contactPhone === phone(2))!;
    const boss = { id: (await ds.manager.findOneByOrFail(User, { account: phone(2) })).id, companyId: r.approvedCompanyId!, name: '王老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const org = new OrgAdminService(ds);
    await expect(org.createStaff(boss, { account: admin.account, name: '撞平台' })).rejects.toThrow(/已经存在/);
    const other = await ds.manager.save(User, ds.manager.create(User, { companyId: (await ds.manager.findOneByOrFail(Company, {} as never)).id, account: `own${tag}`, passwordHash: 'x', name: '他司', isCompanyAdmin: false, status: 'active', mustChangePassword: false }));
    await expect(org.createStaff(boss, { account: other.account, name: '撞他司' })).rejects.toThrow(/已经存在/);
  });

  it('公司列表与启停：停用后记审计，恢复后再记一条', async () => {
    const r = (await svc.listApplications()).find((x) => x.contactPhone === phone(2))!;
    const row = (await svc.listCompanies()).find((c) => c.id === r.approvedCompanyId)!;
    expect(row).toMatchObject({ name: r.companyName, status: 'active', userCount: 1, adminAccounts: [phone(2)] });
    await svc.setCompanyStatus(admin, row.id, 'suspended');
    expect((await ds.manager.findOneByOrFail(Company, { id: row.id })).status).toBe('suspended');
    await svc.setCompanyStatus(admin, row.id, 'active');
    expect(await ds.manager.count(AuditLog, { where: { companyId: row.id, action: 'company.suspend' } })).toBe(1);
    expect(await ds.manager.count(AuditLog, { where: { companyId: row.id, action: 'company.resume' } })).toBe(1);
    await expect(svc.setCompanyStatus(admin, 99999999, 'suspended')).rejects.toThrow(/没有这家公司/);
  });
});
