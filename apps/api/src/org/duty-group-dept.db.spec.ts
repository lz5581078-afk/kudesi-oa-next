/**
 * 职责组按部门分类（真实数据库）：所属部门字段与校验、按部门（含下级）筛选、未分类页签、公司隔离、
 * 删除部门时职责组转移、部门卷宗里的职责组、岗位职责条数、流程引用查询。
 *   RESOURCE_DB_TEST=1 TEST_DB_NAME=<库> npx jest --runInBand duty-group-dept
 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { getResourceDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FlowDefinition, User } from '../entities';
import { FlowDesignerService } from '../flow/flow-designer.service';
import { assertCondValid, condSql, newCondCtx } from '../resources/def-conditions';
import { ResourcesService } from '../resources/resources.service';
import { buildServices } from '../test-support';
import { OrgAdminService } from './org-admin.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const T = crypto.randomBytes(3).toString('hex');

d('职责组按部门分类（真实数据库）', () => {
  let ds: DataSource;
  let res: ResourcesService;
  let org: OrgAdminService;
  let boss: AuthUser;
  let other: AuthUser;
  let top: number, child: number, fin: number;
  const dept = async (u: AuthUser, name: string, parent: number | null) => Number((await ds.manager.query('INSERT INTO departments (company_id, parent_id, name, sort_order) VALUES (?, ?, ?, 0)', [u.companyId, parent, name])).insertId);
  const ids = async (opts: Record<string, unknown>, u = boss) => (await res.list(u, 'duty-groups', { pageSize: 100, showHidden: true, ...opts })).items.map((i) => i.title).sort();

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    res = buildServices(ds).resources;
    org = new OrgAdminService(ds);
    const mk = async (tag: string) => {
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `dg${tag}${crypto.randomBytes(4).toString('hex')}`, name: `职责组部门${tag}`, status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
      return { c, u };
    };
    const a = await mk('a');
    const b = await mk('b');
    boss = { id: a.u.id, companyId: a.c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    other = { id: b.u.id, companyId: b.c.id, name: '他司', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    top = await dept(boss, '运营部', null);
    child = await dept(boss, '抖音运营组', top);
    fin = await dept(boss, '财务部', null);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('配置自检：所属部门是部门引用字段，部门筛选条件合法，分组字段存在', () => {
    const def = getResourceDef('duty-groups')!;
    expect(def.fields.find((f) => f.key === 'departmentId')).toMatchObject({ type: 'ref', ref: 'department' });
    expect(def.listGroupBy).toMatchObject({ field: 'departmentId', emptyLabel: '未分类' });
    for (const f of def.computedFilters ?? []) { const ctx = newCondCtx(); ctx.dyn = '1'; expect(condSql(def, f.when!, 'r', ctx)).toContain('departments'); } // 下拉选中的部门代入 $value
    for (const t of def.quickTabs ?? []) assertCondValid(def, t.when);
  });

  it('新建可选部门；部门必须是本公司的；没选部门归“未分类”页签', async () => {
    const g1 = await res.create(boss, 'duty-groups', { groupKey: `ops_${T}`, name: '运营审核组', departmentId: top });
    expect(g1.refLabels.departmentId).toBe('运营部');
    await expect(res.create(boss, 'duty-groups', { groupKey: `bad_${T}`, name: '串部门组', departmentId: await dept(other, '他司部门', null) })).rejects.toThrow(/部门不存在/);
    await res.create(boss, 'duty-groups', { groupKey: `fin_${T}`, name: '财务审核组', departmentId: fin });
    await res.create(boss, 'duty-groups', { groupKey: `old_${T}`, name: '历史职责组' });
    expect(await ids({ tab: 'q:uncat' })).toEqual(['历史职责组']);
    const stopped = await res.create(boss, 'duty-groups', { groupKey: `stop_${T}`, name: '停用无部门组' });
    await res.changeStatus(boss, 'duty-groups', stopped.id, 'inactive', '合并');
    expect(await ids({ tab: 'q:uncat' })).toEqual(['历史职责组']); // 停用的不算未分类待办
  });

  it('按部门筛选包含下级部门；选别家的部门或乱写的值被拒绝', async () => {
    await res.create(boss, 'duty-groups', { groupKey: `dy_${T}`, name: '抖音审核组', departmentId: child });
    const byTop = await ids({ filters: JSON.stringify({ dutyDept: top }) });
    expect(byTop).toEqual(['抖音审核组', '运营审核组']);
    expect(await ids({ filters: JSON.stringify({ dutyDept: child }) })).toEqual(['抖音审核组']);
    expect(await ids({ filters: JSON.stringify({ dutyDept: fin }) })).toEqual(['财务审核组']);
    const foreign = await dept(other, '他司部门2', null);
    await expect(ids({ filters: JSON.stringify({ dutyDept: foreign }) })).rejects.toThrow(); // 别家的部门直接拒绝
    await expect(ids({ filters: JSON.stringify({ dutyDept: 'x; DROP TABLE users' }) })).rejects.toThrow();
  });

  it('公司隔离：别家看不到本司职责组，也不能把别家的职责组改到本司部门', async () => {
    expect(await ids({}, other)).toEqual([]);
    const mine = (await res.list(boss, 'duty-groups', { pageSize: 100 })).items.find((i) => i.title === '财务审核组')!;
    await expect(res.update(other, 'duty-groups', mine.id, { departmentId: fin })).rejects.toThrow();
  });

  it('部门卷宗显示归在本部门的职责组及在组人数；岗位列表带职责条数', async () => {
    const st = await org.createStaff(boss, { account: `dgm${T}`, name: '组员', departmentId: top });
    const grp = (await res.list(boss, 'duty-groups', { pageSize: 100 })).items.find((i) => i.title === '运营审核组')!;
    await res.create(boss, 'duty-group-members', { groupId: grp.id, userId: st.staff.id });
    const profile = await org.departmentProfile(boss, top);
    expect(profile.dutyGroups).toEqual([{ id: grp.id, title: '运营审核组', status: 'normal', memberCount: 1 }]);
    expect((await org.departmentProfile(boss, fin)).dutyGroups.map((g) => g.title)).toEqual(['财务审核组']);
    const p = await org.createPosition(boss, { name: `带职责岗${T}`, departmentId: top, workspaceType: 'operations' });
    await org.createDuty(boss, p.id, { category: '岗位职责', title: '盯日报' });
    const off = await org.createDuty(boss, p.id, { category: '入职培训', title: '旧培训' });
    await org.updateDuty(boss, off.id, { status: 'inactive', reason: '不再使用' });
    expect((await org.listPositions(boss)).find((x) => x.id === p.id)!.dutyCount).toBe(1);
    expect((await org.departmentProfile(boss, top)).positions.find((x) => x.id === p.id)).toMatchObject({ dutyCount: 1, workspaceType: 'operations' });
  });

  it('删除部门：职责组算需要转移的内容，转到接收部门并留日志；不指定接收部门不能删', async () => {
    const x = await dept(boss, '待删部门', null);
    const to = await dept(boss, '接收部门', null);
    const g = await res.create(boss, 'duty-groups', { groupKey: `mv_${T}`, name: '待转移组', departmentId: x });
    await expect(org.deleteDepartment(boss, x)).rejects.toThrow(/职责组/);
    const r = await org.deleteDepartment(boss, x, to);
    expect(r.moved.dutyGroups).toBe(1);
    expect((await res.get(boss, 'duty-groups', g.id)).data.departmentId).toBe(to);
    const logs = await ds.manager.query("SELECT note FROM resource_change_logs WHERE company_id = ? AND resource_type = 'duty-groups' AND resource_id = ? AND action = 'department_transferred'", [boss.companyId, g.id]);
    expect(logs[0].note).toMatch(/接收部门/);
  });

  it('流程引用：启用/草稿版本里“按职责组办理”的步骤能查到；别家的流程查不到', async () => {
    const grp = (await res.list(boss, 'duty-groups', { pageSize: 100 })).items.find((i) => i.title === '运营审核组')!;
    const designer = new FlowDesignerService(ds, null as never);
    expect(await designer.dutyGroupUsage(boss, grp.id)).toEqual([]);
    const steps = [{ key: 'apply', name: '提交申请', type: 'submit', assignee: { source: 'requester' } }, { key: 'rv', name: '运营审核', type: 'approval', assignee: { source: 'duty_group', id: grp.id } }, { key: 'end', name: '结束', type: 'end' }];
    await ds.manager.save(FlowDefinition, ds.manager.create(FlowDefinition, { companyId: boss.companyId, templateKey: 'license-borrow', version: 90 + Math.floor(Math.random() * 9000), status: 'draft', steps, escalateUserIds: [], createdBy: boss.id } as never));
    const u = await designer.dutyGroupUsage(boss, grp.id);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ stepName: '运营审核', draft: true });
    expect(await designer.dutyGroupUsage(other, grp.id)).toEqual([]);
  });
});
