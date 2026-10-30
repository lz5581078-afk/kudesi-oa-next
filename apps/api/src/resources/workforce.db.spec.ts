/** 兼职与临时工（资料）的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=<库名> npx jest --runInBand workforce */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { todayShanghai, addDaysText } from '@kudesi/shared';
import { AuthService } from '../auth/auth.service';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, Department, EmployeeCompensationRecord, Position, PositionPermission, PlatformAdmin, ResourceRecord, TaskRoutine, User, UserPermissionOverride, WorkItem } from '../entities';
import { unfiledWorkforce, workforceBlockFor } from '../workforce/workforce-contract';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const T = crypto.randomBytes(3).toString('hex');
const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const today = todayShanghai();
const day = (n: number) => addDaysText(today, n);

d('兼职与临时工（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let hr: AuthUser; // 有档案权限但没有薪资权限
  let other: AuthUser;
  let companyId: number;
  let deptA: Department;
  let deptB: Department;
  let pos: Position;

  const mkUser = (account: string, extra: Partial<User> = {}) =>
    ds.manager.save(User, ds.manager.create(User, { companyId, account: `${account}${T}`, passwordHash: 'x', name: account, status: 'active', mustChangePassword: false, departmentId: deptA.id, ...extra } as never));
  const terms = (userId: number, extra: Record<string, unknown> = {}) => ({ userId, employmentType: 'part_time', contractStartDate: day(-10), payMethod: 'daily', payRate: 20000, ...extra });

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const mkCompany = async (tag: string) => {
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `w${tag}${crypto.randomBytes(4).toString('hex')}`, name: `兼职测试${tag}`, status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `wfboss${tag}${T}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false } as never));
      return { c, u };
    };
    const a = await mkCompany('a');
    const b = await mkCompany('b');
    companyId = a.c.id;
    boss = { id: a.u.id, companyId, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    other = { id: b.u.id, companyId: b.c.id, name: '他司', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    deptA = await ds.manager.save(Department, ds.manager.create(Department, { companyId, parentId: null, name: '仓库', sortOrder: 0 } as never));
    deptB = await ds.manager.save(Department, ds.manager.create(Department, { companyId, parentId: null, name: '运营', sortOrder: 1 } as never));
    pos = await ds.manager.save(Position, ds.manager.create(Position, { companyId, departmentId: deptA.id, name: `打包${T}`, workspaceType: 'warehouse', sortOrder: 0 } as never));
    const h = await mkUser('hr');
    hr = { id: h.id, companyId, name: 'hr', permissions: { isCompanyAdmin: false, allow: ['resource.workforce.view', 'resource.workforce.create', 'resource.workforce.edit'], deny: [] } };
  }, 120000);
  afterAll(async () => { await ds?.destroy(); });

  it('建档：姓名取自员工、用工类型同步给账号、冗余字段读时按员工当前资料；同一员工只能一条；重复/跨公司/管理员被拒', async () => {
    const u = await mkUser('li', { positionId: pos.id });
    const rec = await svc.create(boss, 'workforce', terms(u.id, { employmentType: 'temp', contractEndDate: day(20), phone: '138-0000-1111', workLocation: 'A区仓库' }));
    expect(rec.title).toBe('li');
    expect(rec.data).toMatchObject({ name: 'li', employmentType: 'temp', cooperation: 'working', departmentName: '仓库', positionName: `打包${T}`, accountStatus: 'active', phone: '13800001111' });
    expect((await ds.manager.findOneByOrFail(User, { id: u.id })).employmentType).toBe('temp');
    await expect(svc.create(boss, 'workforce', terms(u.id))).rejects.toThrow(/已存在/);
    await expect(svc.create(boss, 'workforce', terms(boss.id))).rejects.toThrow(/公司管理员/);
    await expect(svc.create(other, 'workforce', terms(u.id))).rejects.toThrow(/员工不存在/);
    // 员工改名、换部门后，读出来是当前资料
    await ds.manager.update(User, { id: u.id }, { departmentId: deptB.id });
    expect((await svc.get(boss, 'workforce', rec.id)).data.departmentName).toBe('运营');
    // 不能换人，不能删除
    const v = await mkUser('wang');
    await expect(svc.update(boss, 'workforce', rec.id, { userId: v.id })).rejects.toThrow(/不能更换/);
    await expect(svc.remove(boss, 'workforce', rec.id, '想删')).rejects.toThrow(/不能删除/);
  }, 60000);

  it('期限规则：临时工必填结束日期、结束不早于开始、开始日期必须是真实日期、单价上限', async () => {
    const u = await mkUser('zhao');
    await expect(svc.create(boss, 'workforce', terms(u.id, { employmentType: 'temp' }))).rejects.toThrow(/临时工必须填写合作结束日期/);
    await expect(svc.create(boss, 'workforce', terms(u.id, { employmentType: 'temp', contractEndDate: day(-11) }))).rejects.toThrow(/不能早于/);
    await expect(svc.create(boss, 'workforce', terms(u.id, { contractStartDate: '2026-02-30' }))).rejects.toThrow(/开始日期/);
    await expect(svc.create(boss, 'workforce', terms(u.id, { payRate: 10_000_000 * 100 + 1 }))).rejects.toThrow(/单价/);
    await expect(svc.create(boss, 'workforce', { userId: u.id, employmentType: 'part_time', payMethod: 'daily' })).rejects.toThrow(/合作开始日期/);
    const ok = await svc.create(boss, 'workforce', terms(u.id)); // 兼职可以不限期
    expect(ok.data.contractEndDate).toBeUndefined();
  }, 60000);

  it('薪资字段服务端脱敏：没有薪资权限的人看不到也改不了计薪；有权限的人能看', async () => {
    const u = await mkUser('qian');
    const rec = await svc.create(boss, 'workforce', terms(u.id, { payMethod: 'daily', payRate: 25000 }));
    expect(rec.data.payRate).toBe(25000);
    const seen = await svc.get(hr, 'workforce', rec.id);
    expect(seen.data.payRate).toBeUndefined();
    expect(seen.data.payMethod).toBeUndefined();
    const list = await svc.list(hr, 'workforce', { pageSize: 50 } as never);
    expect(JSON.stringify(list)).not.toContain('25000');
    await svc.update(hr, 'workforce', rec.id, { payRate: 99900, workLocation: '改了地点' });
    const after = await svc.get(boss, 'workforce', rec.id);
    expect(after.data.payRate).toBe(25000); // 没权限提交的计薪被丢弃
    expect(after.data.workLocation).toBe('改了地点');
    const logs = await svc.logs(hr, 'workforce', rec.id);
    expect(JSON.stringify(logs)).not.toContain('25000');
    // 没有薪资权限的人建档：不会碰员工的计薪
    const w = await mkUser('sun');
    await svc.create(hr, 'workforce', { userId: w.id, employmentType: 'part_time', contractStartDate: day(-1) });
    expect((await ds.manager.findOneByOrFail(User, { id: w.id })).payType).toBe('monthly');
  }, 60000);

  it('计时且单价>0 同步为员工时薪（直播主播工资默认取它），写薪资变更记录；改成计天后回到月薪', async () => {
    const u = await mkUser('zhou');
    const rec = await svc.create(boss, 'workforce', terms(u.id, { payMethod: 'hourly', payRate: 3500 }));
    let row = await ds.manager.findOneByOrFail(User, { id: u.id });
    expect(row).toMatchObject({ payType: 'hourly', hourlyRate: 3500, employmentType: 'part_time' });
    await svc.update(boss, 'workforce', rec.id, { payRate: 4000 });
    row = await ds.manager.findOneByOrFail(User, { id: u.id });
    expect(row.hourlyRate).toBe(4000);
    const records = await ds.manager.find(EmployeeCompensationRecord, { where: { companyId, userId: u.id }, order: { id: 'ASC' } });
    expect(records.map((r) => r.title)).toEqual(['计薪方式变更', '时薪变更']);
    await svc.update(boss, 'workforce', rec.id, { payMethod: 'daily', payRate: 20000 });
    row = await ds.manager.findOneByOrFail(User, { id: u.id });
    expect(row).toMatchObject({ payType: 'monthly', hourlyRate: null });
    // 单价 0（旧系统迁入的“还没定价”）不覆盖员工时薪
    const z = await mkUser('wu', { payType: 'hourly', hourlyRate: 5000 });
    await svc.create(boss, 'workforce', terms(z.id, { payMethod: 'hourly', payRate: 0 }));
    expect((await ds.manager.findOneByOrFail(User, { id: z.id })).hourlyRate).toBe(5000);
  }, 60000);

  it('列表页签和筛选：合作中/待开始/已到期/没有岗位/7 天内结束、部门、用工类型', async () => {
    const mk = async (name: string, t: Record<string, unknown>, extra: Partial<User> = {}) => {
      const u = await mkUser(name, { positionId: pos.id, ...extra });
      return (await svc.create(boss, 'workforce', terms(u.id, t))).id;
    };
    const working = await mk('tab-w', { contractEndDate: day(30) });
    const pending = await mk('tab-p', { contractStartDate: day(1), employmentType: 'temp', contractEndDate: day(9) });
    // 账号还会拼接随机后缀；搜索词不能是其他样例账号的前缀（旧 tab-e + 0... 会误中 tab-e0）。
    const endedToday = await mk('tab-ends-today', { contractStartDate: day(-9), contractEndDate: day(0) });
    const ended = await mk('tab-e', { contractStartDate: day(-20), contractEndDate: day(-1) });
    const ending = await mk('tab-g', { contractEndDate: day(5) });
    const nopos = await mk('tab-n', {}, { positionId: null, departmentId: deptB.id });
    const ids = async (q: Record<string, unknown>) => ((await svc.list(boss, 'workforce', { pageSize: 100, ...q } as never)).items as Array<{ id: number }>).map((i) => i.id);
    const w = await ids({ tab: 'q:working' });
    expect(w).toEqual(expect.arrayContaining([working, endedToday, ending, nopos]));
    expect(w).not.toContain(pending);
    expect(w).not.toContain(ended);
    expect(await ids({ tab: 'q:pending' })).toEqual([pending]);
    expect(await ids({ tab: 'q:ended' })).toEqual(expect.arrayContaining([ended]));
    expect(await ids({ tab: 'q:ended' })).not.toContain(endedToday);
    expect(await ids({ tab: 'q:no-position' })).toEqual(expect.arrayContaining([nopos]));
    expect(await ids({ tab: 'q:no-position' })).not.toContain(working);
    const soon = await ids({ tab: 'q:ending' });
    expect(soon).toEqual(expect.arrayContaining([ending, endedToday]));
    expect(soon).not.toContain(working);
    expect(await ids({ filters: JSON.stringify({ dept: deptB.id }) })).toEqual(expect.arrayContaining([nopos]));
    expect(await ids({ filters: JSON.stringify({ dept: deptB.id }) })).not.toContain(working);
    expect(await ids({ filters: JSON.stringify({ employmentType: 'temp' }) })).toEqual(expect.arrayContaining([pending]));
    expect(await ids({ filters: JSON.stringify({ employmentType: 'temp' }) })).not.toContain(working);
    expect(await ids({ keyword: 'tab-ends-today' })).toEqual([endedToday]);
    // 合作状态是读时算的：已到期的那条读出来是 ended，待开始是 pending
    expect((await svc.get(boss, 'workforce', ended)).data.cooperation).toBe('ended');
    expect((await svc.get(boss, 'workforce', pending)).data.cooperation).toBe('pending');
    // 到期提醒：7 天内结束的进“即将到期”，已结束的算已过期
    const exp = await svc.expiring(boss, 7, true);
    const mine = exp.rows.filter((r) => r.type === 'workforce').map((r) => r.id);
    expect(mine).toEqual(expect.arrayContaining([ending, endedToday, ended]));
    expect(mine).not.toContain(working);
    // 列筛选里读时才算的列不能筛
    await expect(svc.list(boss, 'workforce', { colFilters: JSON.stringify([{ key: 'cooperation', op: 'eq', value: 'ended' }]) } as never)).rejects.toThrow();
  }, 120000);

  it('合作期外不能登录（登录和已登录的令牌都挡）；没建档的兼职不受限；正式员工不受限', async () => {
    const mkLogin = async (name: string, t?: Record<string, unknown>) => {
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId, account: `${name}${T}`, passwordHash: await (await import('bcryptjs')).hash('pw-123456', 4), name, status: 'active', mustChangePassword: false, departmentId: deptA.id } as never));
      if (t) await svc.create(boss, 'workforce', terms(u.id, t));
      return u;
    };
    const auth = new AuthService(
      { signAsync: async () => 'tok' } as never, ds.getRepository(Company), ds.getRepository(PlatformAdmin), ds.getRepository(User), ds.getRepository(Position),
      ds.getRepository(PositionPermission), ds.getRepository(UserPermissionOverride), ds.getRepository(AuditLog),
    );
    const ended = await mkLogin('lg-e', { contractStartDate: day(-20), contractEndDate: day(-1) });
    const pending = await mkLogin('lg-p', { contractStartDate: day(3) });
    const live = await mkLogin('lg-ok', { contractEndDate: day(0) });
    const unfiled = await mkLogin('lg-un');
    await ds.manager.update(User, { id: unfiled.id }, { employmentType: 'part_time' });
    const regular = await mkLogin('lg-reg');
    await expect(auth.login(ended.account!, 'pw-123456')).rejects.toThrow(/合作期已结束/);
    await expect(auth.login(pending.account!, 'pw-123456')).rejects.toThrow(/尚未开始/);
    await expect(auth.login(ended.account!, 'wrong-pass')).rejects.toThrow(/账号或密码不正确/); // 密码错不透露合作期
    for (const u of [live, unfiled, regular]) expect((await auth.login(u.account!, 'pw-123456')).type).toBe('company');
    // 令牌入口（守卫用的同一个检查）：到期次日起挡住
    const fresh = await ds.manager.findOneByOrFail(User, { id: live.id });
    expect(await workforceBlockFor(ds.manager, fresh, today)).toBeNull();
    expect(await workforceBlockFor(ds.manager, fresh, day(1))).toMatch(/合作期已结束/);
    // 未建档提示
    const list = await unfiledWorkforce(ds.manager, companyId);
    expect(list.map((x) => x.id)).toContain(unfiled.id);
    expect(list.map((x) => x.id)).not.toContain(live.id);
    expect(await unfiledWorkforce(ds.manager, other.companyId)).toEqual([]);
  }, 120000);

  it('停用：必须填原因；账号一并停用并把待办/周期任务交接；重新启用恢复账号；不能停用自己', async () => {
    const u = await mkUser('tingyong', { positionId: pos.id });
    await mkUser('mate', { positionId: pos.id });
    const rec = await svc.create(boss, 'workforce', terms(u.id));
    await ds.manager.save(WorkItem, ds.manager.create(WorkItem, { companyId, kind: 'task', assigneeId: u.id, title: '待办一', status: 'open' } as never));
    await ds.manager.save(TaskRoutine, ds.manager.create(TaskRoutine, { companyId, title: '周期一', frequency: 'daily', createdBy: boss.id, assigneeId: u.id, active: true } as never));
    await expect(svc.changeStatus(boss, 'workforce', rec.id, 'inactive', '')).rejects.toThrow(/原因/);
    const res = await svc.changeStatus(boss, 'workforce', rec.id, 'inactive', '合作结束');
    expect(res.status).toBe('inactive');
    expect(res.statusReason).toBe('合作结束');
    expect(res.data.cooperation).toBe('inactive');
    expect(res.data.accountStatus).toBe('disabled');
    expect((await ds.manager.findOneByOrFail(User, { id: u.id })).status).toBe('disabled');
    const moved = (await ds.manager.findOneByOrFail(WorkItem, { companyId, title: '待办一' })).assigneeId;
    expect(moved).not.toBe(u.id); // 交给同岗位的在职同事（最早建的那位）
    expect((await ds.manager.findOneByOrFail(User, { id: moved })).positionId).toBe(pos.id);
    expect((await ds.manager.findOneByOrFail(TaskRoutine, { companyId, title: '周期一' })).assigneeId).toBe(moved);
    expect((await ds.manager.find(AuditLog, { where: { companyId, resourceType: 'user', resourceId: String(u.id) } })).map((a) => a.action)).toEqual(expect.arrayContaining(['user.handover', 'user.disable']));
    const back = await svc.changeStatus(boss, 'workforce', rec.id, 'active');
    expect(back.data.accountStatus).toBe('active');
    expect((await ds.manager.findOneByOrFail(User, { id: u.id })).status).toBe('active');
    const me = await mkUser('selfstop');
    const mine = await svc.create(boss, 'workforce', terms(me.id));
    const asSelf: AuthUser = { id: me.id, companyId, name: 'selfstop', permissions: { isCompanyAdmin: false, allow: ['resource.workforce.*'], deny: [] } };
    await expect(svc.changeStatus(asSelf, 'workforce', mine.id, 'inactive', '自己停')).rejects.toThrow(/不能停用自己/);
    // 批量停用也走同一流程
    const r = await svc.batchUpdate(boss, 'workforce', [mine.id], {}, 'inactive', '批量停用');
    expect(r.done).toBe(1);
    expect((await ds.manager.findOneByOrFail(User, { id: me.id })).status).toBe('disabled');
  }, 120000);

  it('附件合计最多 20 个；表格保存、导出遵守薪资脱敏', async () => {
    const u = await mkUser('fujian');
    const rec = await svc.create(boss, 'workforce', terms(u.id));
    const fake = (n: number) => Array.from({ length: n }, (_, i) => 900000 + i);
    await expect(svc.update(boss, 'workforce', rec.id, { contractFiles: fake(11), identityFiles: fake(10) })).rejects.toThrow(/最多上传 20/);
    const csv = (await svc.exportCsv(hr, 'workforce', true)).csv;
    expect(csv).not.toContain('单价');
    expect((await svc.exportCsv(boss, 'workforce', true)).csv).toContain('单价');
    // 搜索：姓名、账号、手机号、部门、岗位
    await svc.update(boss, 'workforce', rec.id, { phone: '13900002222' });
    expect(((await svc.list(boss, 'workforce', { keyword: '13900002222' } as never)).items as unknown[]).length).toBe(1);
    expect(((await svc.list(boss, 'workforce', { keyword: `fujian${T}` } as never)).items as unknown[]).length).toBe(1);
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: other.companyId, type: 'workforce' } })).toBe(0);
  }, 60000);
});
