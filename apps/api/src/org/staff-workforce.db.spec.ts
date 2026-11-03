import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { todayShanghai } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, EmployeeCompensationRecord, ResourceChangeLog, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { workforceBlockFor } from '../workforce/workforce-contract';
import { workforceBeforeSave } from '../resources/workforce-rules';
import { OrgAdminService } from './org-admin.service';
import { staffWorkforceRecord } from './staff-workforce';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('员工编辑与用工档案同事务联动', () => {
  let ds: DataSource, services: ReturnType<typeof buildServices>, org: OrgAdminService, boss: AuthUser, other: AuthUser;
  const account = () => randomBytes(10).toString('hex');
  const mk = async (extra: Partial<User> = {}) => ds.manager.save(User, ds.manager.create(User, { companyId: boss.companyId, account: account(), passwordHash: 'x', name: '待编辑员工', status: 'active', ...extra }));
  const getFile = (id: number) => staffWorkforceRecord(ds.manager, boss.companyId, id);
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true } as never).initialize();
    services = buildServices(ds); org = new OrgAdminService(ds, services.resources);
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: account(), name: '员工编辑测试公司', status: 'active' }));
    const admin = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: account(), name: '管理员', passwordHash: 'x', isCompanyAdmin: true, status: 'active' }));
    boss = { id: admin.id, companyId: company.id, name: admin.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const c2 = await ds.manager.save(Company, ds.manager.create(Company, { code: account(), name: '他司', status: 'active' }));
    other = { ...boss, companyId: c2.id };
  }, 120000);
  afterAll(async () => { await ds?.destroy(); });

  it('已有账号改兼职自动建档；重复和并发保存复用唯一档案，不创建新账号', async () => {
    const person = await mk({ account: '139' + Date.now().toString().slice(-8) });
    const result = await org.updateStaff(boss, person.id, { employmentType: 'part_time', contractStartDate: '2026-01-01' });
    expect(result).toMatchObject({ id: person.id, employmentType: 'part_time', contractStartDate: '2026-01-01', contractEndDate: null });
    const first = (await getFile(person.id))!;
    expect(first.data).toMatchObject({ userId: person.id, phone: person.account, employmentType: 'part_time', contractStartDate: '2026-01-01' });
    await Promise.all([org.updateStaff(boss, person.id, { employmentType: 'part_time' }), org.updateStaff(boss, person.id, { employmentType: 'part_time' })]);
    expect((await getFile(person.id))!.id).toBe(first.id);
    expect(await ds.manager.count(User, { where: { companyId: boss.companyId, account: person.account! } })).toBe(1);
  });

  it('临时工日期校验失败整笔回滚，合法期限控制登录；兼职可清空结束日期', async () => {
    const person = await mk();
    for (const dates of [{}, { contractStartDate: '2026-02-30', contractEndDate: '2099-01-01' }, { contractStartDate: '2026-04-02', contractEndDate: '2026-04-01' }]) {
      await expect(org.updateStaff(boss, person.id, { name: '不能保存的姓名', employmentType: 'temp', ...dates })).rejects.toThrow();
      expect((await ds.manager.findOneByOrFail(User, { id: person.id })).name).toBe(person.name);
      expect(await getFile(person.id)).toBeNull();
    }
    await org.updateStaff(boss, person.id, { employmentType: 'temp', contractStartDate: '2026-01-01', contractEndDate: '2026-02-01' });
    let user = await ds.manager.findOneByOrFail(User, { id: person.id });
    expect(await workforceBlockFor(ds.manager, user, '2026-02-02')).toMatch(/已结束/);
    await org.updateStaff(boss, person.id, { employmentType: 'part_time', contractEndDate: null });
    user = await ds.manager.findOneByOrFail(User, { id: person.id });
    expect(await workforceBlockFor(ds.manager, user, '2026-02-02')).toBeNull();
    expect((await getFile(person.id))!.data.contractEndDate).toBeUndefined();
  });

  it('编辑合作期只改同一档案，计薪/联系人/附件引用和薪资历史保持', async () => {
    const person = await mk();
    const record = await services.resources.create(boss, 'workforce', { userId: person.id, employmentType: 'part_time', contractStartDate: '2026-01-01', payMethod: 'hourly', payRate: 5500, emergencyContactName: '原联系人', shiftNote: '原排班' });
    const before = await ds.manager.findOneByOrFail(ResourceRecord, { id: record.id });
    const count = await ds.manager.count(EmployeeCompensationRecord, { where: { companyId: boss.companyId, userId: person.id } });
    await org.updateStaff(boss, person.id, { employmentType: 'temp', contractEndDate: '2099-01-01' });
    const after = (await getFile(person.id))!;
    expect(after.id).toBe(record.id);
    for (const key of ['payMethod', 'payRate', 'emergencyContactName', 'shiftNote', 'contractFiles', 'identityFiles']) expect(after.data[key]).toEqual(before.data[key]);
    expect((await ds.manager.findOneByOrFail(User, { id: person.id })).hourlyRate).toBe(5500);
    expect(await ds.manager.count(EmployeeCompensationRecord, { where: { companyId: boss.companyId, userId: person.id } })).toBe(count);
  });

  it('转正式保留历史档案且不禁用账号、不变更计薪，再转兼职恢复同一份资料', async () => {
    const person = await mk();
    await org.updateStaff(boss, person.id, { employmentType: 'part_time', contractStartDate: '2026-01-01' });
    const id = (await getFile(person.id))!.id;
    await org.updateStaff(boss, person.id, { employmentType: 'regular' });
    const historical = (await getFile(person.id))!;
    expect(historical.archivedAt).toBeTruthy();
    const user = await ds.manager.findOneByOrFail(User, { id: person.id });
    expect(user.status).toBe('active');
    expect(await workforceBlockFor(ds.manager, user)).toBeNull();
    expect((await services.resources.list(boss, 'workforce', {} as never)).items.map(r => r.id)).not.toContain(id);
    expect((await services.resources.list(boss, 'workforce', { archived: true } as never)).items.map(r => r.id)).toContain(id);
    await expect(services.resources.update(boss, 'workforce', id, { contractEndDate: '2099-01-01' })).rejects.toThrow(/已归档/);
    await org.updateStaff(boss, person.id, { employmentType: 'temp', contractStartDate: todayShanghai(), contractEndDate: '2099-01-01' });
    expect((await getFile(person.id))!).toMatchObject({ id, archivedAt: null, status: 'active' });
    const logs = await ds.manager.find(ResourceChangeLog, { where: { companyId: boss.companyId, resourceId: id, resourceType: 'workforce' } });
    expect(logs.map(r => r.action)).toEqual(expect.arrayContaining(['create', 'archived', 'restored', 'update']));
  });

  it('转正式后旧档案编辑被拒，不能把旧快照覆盖回兼职', async () => {
    const person = await mk();
    await org.updateStaff(boss, person.id, { employmentType: 'part_time' });
    const stale = (await getFile(person.id))!;
    await org.updateStaff(boss, person.id, { employmentType: 'regular' });
    await expect(ds.transaction(em => workforceBeforeSave({ em, user: boss, data: { ...stale.data }, existing: stale } as never))).rejects.toThrow(/已归档/);
    expect((await ds.manager.findOneByOrFail(User, { id: person.id })).employmentType).toBe('regular');
  });

  it('权限不足或档案写入失败回滚账号；跨公司、管理员类型变更拒绝', async () => {
    const person = await mk();
    const limited: AuthUser = { ...boss, permissions: { isCompanyAdmin: false, allow: ['org.staff.edit'], deny: [] } };
    await expect(org.updateStaff(limited, person.id, { employmentType: 'part_time' })).rejects.toThrow(/没有创建/);
    expect((await ds.manager.findOneByOrFail(User, { id: person.id })).employmentType).toBe('regular');
    await expect(org.updateStaff(other, person.id, { employmentType: 'part_time' })).rejects.toThrow(/不存在/);
    await expect(org.updateStaff(boss, boss.id, { employmentType: 'part_time' })).rejects.toThrow(/公司管理员/);
    const fail = jest.spyOn(services.resources, 'createRecord').mockRejectedValueOnce(new Error('建档失败'));
    await expect(org.updateStaff(boss, person.id, { employmentType: 'part_time' })).rejects.toThrow('建档失败');
    fail.mockRestore();
    expect((await ds.manager.findOneByOrFail(User, { id: person.id })).employmentType).toBe('regular');
    await org.updateStaff(boss, person.id, { employmentType: 'part_time' });
    await expect(org.updateStaff(limited, person.id, { employmentType: 'regular' })).rejects.toThrow(/没有修改/);
    expect((await getFile(person.id))!.archivedAt).toBeNull();
    await org.updateStaff(limited, person.id, { employmentType: 'part_time' }); // 未改合作期不另需档案写权限
  });
});
