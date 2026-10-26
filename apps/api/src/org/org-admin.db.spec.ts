/** 组织与权限管理的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test npm test -w @kudesi/api -- org-admin */
import 'reflect-metadata';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, User } from '../entities';
import { OrgAdminService, generatePassword } from './org-admin.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('组织与权限管理（真实数据库）', () => {
  let ds: DataSource;
  let svc: OrgAdminService;
  let boss: AuthUser;
  let other: AuthUser;
  let manager: AuthUser; // 只有“员工管理”权限的非管理员

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = new OrgAdminService(ds);
    const mk = async (tag: string) => {
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `o${tag}${crypto.randomBytes(4).toString('hex')}`, name: `组织测试${tag}`, status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
      return { c, u };
    };
    const a = await mk('a');
    const b = await mk('b');
    boss = { id: a.u.id, companyId: a.c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    other = { id: b.u.id, companyId: b.c.id, name: '他司', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const m = await ds.manager.save(User, ds.manager.create(User, { companyId: a.c.id, account: 'mgr', passwordHash: 'x', name: '主管', isCompanyAdmin: false, status: 'active', mustChangePassword: false }));
    manager = { id: m.id, companyId: a.c.id, name: '主管', permissions: { isCompanyAdmin: false, allow: ['org.staff.edit', 'org.staff.create', 'org.staff.disable', 'org.staff.reset', 'org.structure.edit', 'resource.stores.view'], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('岗位：建、改、设权限只能选清单里的，删除时有人在岗不能删', async () => {
    const p = await svc.createPosition(boss, { name: '运营', workspaceType: 'operations' });
    await expect(svc.createPosition(boss, { name: '运营', workspaceType: 'operations' })).rejects.toThrow(/同名/);
    await expect(svc.setPositionPermissions(boss, p.id, ['resource.stores.view', 'hack.everything'])).rejects.toThrow(/不存在的权限/);
    const set = await svc.setPositionPermissions(boss, p.id, ['resource.stores.view', 'resource.stores.edit', 'resource.stores.view']);
    expect(set.permissions).toEqual(['resource.stores.edit', 'resource.stores.view']);
    const created = await svc.createStaff(boss, { account: 'xiaoyun', name: '小运营', positionId: p.id });
    await expect(svc.deletePosition(boss, p.id)).rejects.toThrow(/还有员工/);
    expect((await svc.listPositions(boss))[0].userCount).toBe(1);
    expect(created.staff.positionName).toBe('运营');
  });

  it('新员工：随机初始密码只返回一次、哈希入库、必须改密码；账号重复被拒', async () => {
    const r = await svc.createStaff(boss, { account: 'zhang3', name: '张三' });
    expect(r.initialPassword).toHaveLength(12);
    const row = await ds.manager.findOneByOrFail(User, { id: r.staff.id });
    expect(row.mustChangePassword).toBe(true);
    expect(await bcrypt.compare(r.initialPassword, row.passwordHash)).toBe(true);
    expect(JSON.stringify(r.staff)).not.toContain(r.initialPassword);
    await expect(svc.createStaff(boss, { account: 'zhang3', name: '重名' })).rejects.toThrow(/已经存在/);
    const reset = await svc.resetPassword(boss, r.staff.id);
    expect(reset.password).not.toBe(r.initialPassword);
    expect(generatePassword()).toMatch(/^[A-Za-z0-9]{12}$/);
  });

  it('跨公司隔离：别家的部门、岗位、员工都找不到', async () => {
    const p = await svc.createPosition(boss, { name: '隔离岗', workspaceType: 'blank' });
    const s = await svc.createStaff(boss, { account: 'iso1', name: '隔离' });
    await expect(svc.createStaff(other, { account: 'x', name: 'x', positionId: p.id })).rejects.toThrow(/岗位不存在/);
    await expect(svc.getStaff(other, s.staff.id)).rejects.toThrow(/不存在/);
    await expect(svc.setStatus(other, s.staff.id, 'disabled', '离职')).rejects.toThrow(/不存在/);
    await expect(svc.setPositionPermissions(other, p.id, [])).rejects.toThrow(/不存在/);
  });

  it('个人权限：允许/拒绝互斥；非管理员不能越权授予、不能改自己、不能动管理员', async () => {
    const s = await svc.createStaff(boss, { account: 'ov1', name: '覆盖' });
    await expect(svc.setOverrides(boss, s.staff.id, ['resource.stores.view'], ['resource.stores.view'])).rejects.toThrow(/既允许又拒绝/);
    const ok = await svc.setOverrides(boss, s.staff.id, ['resource.stores.view'], ['resource.phones.view']);
    expect(ok.allow).toEqual(['resource.stores.view']);
    expect(ok.deny).toEqual(['resource.phones.view']);
    await expect(svc.setOverrides(manager, s.staff.id, ['resource.bank-accounts.view'], [])).rejects.toThrow(/自己没有的权限/);
    await svc.setOverrides(manager, s.staff.id, ['resource.stores.view'], []);
    await expect(svc.setOverrides(manager, manager.id, [], [])).rejects.toThrow(/不能修改自己的权限/);
    await expect(svc.updateStaff(manager, boss.id, { name: '改老板' })).rejects.toThrow(/不能修改公司管理员/);
    await expect(svc.resetPassword(manager, boss.id)).rejects.toThrow(/不能修改公司管理员/);
  });

  it('停用：不能停用自己和最后一个管理员；停用后可再启用；全部变更写审计', async () => {
    await expect(svc.setStatus(boss, boss.id, 'disabled', '测试')).rejects.toThrow(/不能停用自己/);
    const s = await svc.createStaff(boss, { account: 'off1', name: '离职' });
    expect((await svc.setStatus(boss, s.staff.id, 'disabled', '离职')).status).toBe('disabled');
    expect((await svc.setStatus(boss, s.staff.id, 'active')).status).toBe('active');
    const actions = (await ds.manager.find(AuditLog, { where: { companyId: boss.companyId } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['user.create', 'user.disable', 'user.enable', 'user.reset_password', 'position.permissions', 'user.overrides']));
  });

  it('部门：有下级、岗位或员工时不能删；改名写审计', async () => {
    const dep = await ds.manager.query('INSERT INTO departments (company_id, parent_id, name, sort_order) VALUES (?, NULL, ?, 0)', [boss.companyId, '运营部']);
    const id = Number(dep.insertId);
    await svc.updateDepartment(boss, id, { name: '运营中心' });
    await svc.createPosition(boss, { name: '部门岗', departmentId: id, workspaceType: 'blank' });
    await expect(svc.deleteDepartment(boss, id)).rejects.toThrow(/接收部门/);
    await expect(svc.updateDepartment(other, id, { name: 'x' })).rejects.toThrow(/不存在/);
  });

  it('部门：停用要写原因；删除时指定接收部门，下级部门、岗位、员工全部转过去；不能转给自己的下级', async () => {
    const mkDept = async (name: string, parent: number | null) => Number((await ds.manager.query('INSERT INTO departments (company_id, parent_id, name, sort_order) VALUES (?, ?, ?, 0)', [boss.companyId, parent, name])).insertId);
    const a = await mkDept('转出部', null), kid = await mkDept('转出部下级', a), to = await mkDept('接收部', null);
    await expect(svc.updateDepartment(boss, a, { status: 'inactive' })).rejects.toThrow(/必须填写原因/);
    expect((await svc.updateDepartment(boss, a, { status: 'inactive', reason: '合并' })).status).toBe('inactive');
    await svc.updateDepartment(boss, a, { status: 'active' });
    const pos = await svc.createPosition(boss, { name: '转出岗', departmentId: a, workspaceType: 'blank' });
    const st = await svc.createStaff(boss, { account: 'mv1', name: '转移人', departmentId: a });
    await expect(svc.deleteDepartment(boss, a, kid)).rejects.toThrow(/下级部门/);
    await expect(svc.deleteDepartment(boss, a, a)).rejects.toThrow(/不能是被删除/);
    const r = await svc.deleteDepartment(boss, a, to);
    expect(r.moved).toEqual({ kids: 1, positions: 1, users: 1 });
    expect((await svc.getStaff(boss, st.staff.id)).departmentId).toBe(to);
    expect((await svc.listPositions(boss)).find((x) => x.id === pos.id)!.departmentId).toBe(to);
    expect((await ds.manager.query('SELECT parent_id p FROM departments WHERE id = ?', [kid]))[0].p).toBe(to);
  });

  it('岗位档案：层级、上级岗位不成环、停用要原因且在岗有人不能停用；职责条目增删改并留痕', async () => {
    const boss1 = await svc.createPosition(boss, { name: '档案老板岗', workspaceType: 'boss', level: 'boss' });
    const mgr = await svc.createPosition(boss, { name: '档案主管岗', workspaceType: 'general', level: 'manager', supervisorPositionId: boss1.id, description: '带团队' });
    await expect(svc.updatePosition(boss, boss1.id, { supervisorPositionId: mgr.id })).rejects.toThrow(/下级岗位/);
    await expect(svc.updatePosition(boss, mgr.id, { supervisorPositionId: mgr.id })).rejects.toThrow(/不能是自己/);
    const s = await svc.createStaff(boss, { account: 'pf1', name: '在岗人', positionId: mgr.id });
    await expect(svc.updatePosition(boss, mgr.id, { status: 'inactive' })).rejects.toThrow(/必须填写原因/);
    await expect(svc.updatePosition(boss, mgr.id, { status: 'inactive', reason: '撤销岗位' })).rejects.toThrow(/还有在职员工/);
    const duty = await svc.createDuty(boss, mgr.id, { category: '岗位职责', title: '每日巡店', frequency: '每日', isKey: true });
    await expect(svc.createDuty(boss, mgr.id, { category: '乱写', title: 'x' })).rejects.toThrow(/分类不合法/);
    await svc.createDuty(boss, mgr.id, { category: '入职培训', title: '看手册' });
    await svc.updateDuty(boss, duty.id, { completionStandard: '拍照留底' });
    await expect(svc.updateDuty(boss, duty.id, { status: 'inactive' })).rejects.toThrow(/必须填写原因/);
    await svc.updateDuty(boss, duty.id, { status: 'inactive', reason: '不再需要' });
    const prof = await svc.positionProfile(boss, mgr.id);
    expect(prof.position).toMatchObject({ level: 'manager', supervisorPositionName: '档案老板岗', description: '带团队' });
    expect(prof.duties.map((d) => d.category).sort()).toEqual(['入职培训', '岗位职责']);
    expect(prof.duties.find((d) => d.id === duty.id)).toMatchObject({ isKey: true, status: 'inactive', completionStandard: '拍照留底' });
    expect(prof.staff.map((x) => x.id)).toEqual([s.staff.id]);
    expect(prof.logs.length).toBeGreaterThanOrEqual(4);
    await expect(svc.positionProfile(other, mgr.id)).rejects.toThrow(/不存在/);
    await svc.deleteDuty(boss, duty.id);
    expect((await svc.positionProfile(boss, mgr.id)).duties).toHaveLength(1);
  });

  it('员工档案：直属上级不成环、底薪要单独权限；停用时把待办、流程步骤、周期任务交给接收人', async () => {
    const hr = { ...manager, permissions: { isCompanyAdmin: false, allow: ['org.staff.edit', 'org.staff.create', 'org.staff.disable'], deny: [] } };
    const a = (await svc.createStaff(boss, { account: 'hv-a', name: '交接甲', title: '运营经理', baseSalary: 800000 })).staff;
    const b = (await svc.createStaff(boss, { account: 'hv-b', name: '交接乙', managerId: a.id })).staff;
    expect(a).toMatchObject({ title: '运营经理', baseSalary: 800000 });
    expect((await svc.getStaff(hr, a.id)).baseSalary).toBeUndefined(); // 没有底薪权限看不到
    await expect(svc.updateStaff(hr, b.id, { baseSalary: 1 })).rejects.toThrow(/底薪/);
    await expect(svc.updateStaff(boss, a.id, { managerId: b.id })).rejects.toThrow(/下级/);
    await expect(svc.updateStaff(boss, a.id, { managerId: a.id })).rejects.toThrow(/不能是自己/);
    // 给甲造待办、流程步骤、周期任务
    const q = (sql: string, args: unknown[]) => ds.manager.query(sql, args);
    const wi = Number((await q("INSERT INTO work_items (company_id, kind, assignee_id, title, status) VALUES (?, 'task', ?, '甲的待办', 'open')", [boss.companyId, a.id])).insertId);
    const run = Number((await q("INSERT INTO flow_runs (company_id, definition_id, template_key, title, status, requester_id, payload, steps_snapshot, escalate_user_ids) VALUES (?, 1, 'x', '流程', 'running', ?, '{}', '[]', '[]')", [boss.companyId, boss.id])).insertId);
    const step = Number((await q("INSERT INTO flow_steps (company_id, run_id, seq, step_key, step_name, step_type, status, recipients) VALUES (?, ?, 1, 's1', '审批', 'approve', 'active', ?)", [boss.companyId, run, JSON.stringify([a.id])])).insertId);
    const rt = Number((await q("INSERT INTO task_routines (company_id, title, assignee_id, frequency, due_days, active, created_by) VALUES (?, '周期', ?, 'daily', 1, 1, ?)", [boss.companyId, a.id, boss.id])).insertId);
    const pre = await svc.handoverPreview(boss, a.id);
    expect(pre.counts).toMatchObject({ workItems: 1, flowSteps: 1, routines: 1 });
    expect(pre.suggested).toBeTruthy(); // 有建议接收人
    await expect(svc.setStatus(boss, a.id, 'disabled', '离职', 999999)).rejects.toThrow(/接收人/);
    const done = await svc.setStatus(boss, a.id, 'disabled', '离职', b.id);
    expect(done.handover).toMatchObject({ toUserId: b.id, workItems: 1, flowSteps: 1, routines: 1 });
    expect((await q('SELECT assignee_id x FROM work_items WHERE id = ?', [wi]))[0].x).toBe(b.id);
    expect((await q('SELECT recipients x FROM flow_steps WHERE id = ?', [step]))[0].x).toEqual([b.id]);
    expect((await q('SELECT assignee_id x FROM task_routines WHERE id = ?', [rt]))[0].x).toBe(b.id);
    const acts = (await ds.manager.find(AuditLog, { where: { companyId: boss.companyId, action: 'user.handover' } }));
    expect(acts.length).toBeGreaterThanOrEqual(1);
  });

  it('兼任岗位：不能和主岗位相同、没主岗位不能兼任；人数、删除、停用岗位都把兼任算进去', async () => {
    const mkPos = async (name: string) => {
      await svc.createPosition(boss, { name, departmentId: null, workspaceType: 'blank' });
      return (await svc.listPositions(boss)).find((p) => p.name === name)!;
    };
    const main = await mkPos('兼任主岗');
    const side = await mkPos('兼任副岗');
    await expect(svc.createStaff(boss, { account: 'cc-0', name: '无主岗', extraPositionIds: [side.id] })).rejects.toThrow(/主岗位/);
    await expect(svc.createStaff(boss, { account: 'cc-1', name: '相同', positionId: main.id, extraPositionIds: [main.id] })).rejects.toThrow(/相同/);
    const s = (await svc.createStaff(boss, { account: 'cc-2', name: '兼任人', positionId: main.id, extraPositionIds: [side.id] })).staff;
    expect(s.extraPositionIds).toEqual([side.id]);
    expect((await svc.listPositions(boss)).find((p) => p.id === side.id)!.userCount).toBe(1);
    const prof = await svc.positionProfile(boss, side.id);
    expect(prof.staff).toEqual([expect.objectContaining({ id: s.id, concurrent: true })]);
    await expect(svc.deletePosition(boss, side.id)).rejects.toThrow(/员工/);
    await expect(svc.updatePosition(boss, side.id, { status: 'inactive', reason: '不用了' })).rejects.toThrow(/在职员工/);
    // 换主岗位成副岗时，兼任里自动去掉它
    const moved = await svc.updateStaff(boss, s.id, { positionId: side.id });
    expect(moved.extraPositionIds).toEqual([]);
    // 清掉主岗位，兼任一并清空
    const cleared = await svc.updateStaff(boss, s.id, { positionId: null });
    expect(cleared.extraPositionIds).toEqual([]);
  });
});
