/** 流程配置缺口补齐的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=xxx npx jest --runInBand flow-gaps */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource, In } from 'typeorm';
import { type StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, Department, FlowDefinition, Notification, ResourceRecord, User, WorkItem } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { FlowService } from './flow.service';
import { FlowTimeoutService } from './flow-timeout.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('流程缺口补齐（真实数据库）', () => {
  let ds: DataSource;
  let flow: FlowService;
  let timeout: FlowTimeoutService;
  let resources: ReturnType<typeof buildServices>['resources'];
  let admin: AuthUser, req: AuthUser, boss1: AuthUser, keeper: AuthUser, other: AuthUser;
  let companyId = 0;
  const ids: Record<string, number> = {};
  const key = () => crypto.randomBytes(8).toString('hex');
  const day = '2026-03-10';

  const mkUser = async (account: string, name: string, extra: Partial<User> = {}) =>
    (await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra }))).id;
  const au = (id: number, name: string, allow: string[] = []): AuthUser => ({ id, companyId, name, permissions: { isCompanyAdmin: false, allow: ['flow.apply.view', ...allow], deny: [] } });
  const step = (k: string, name: string, type: StepDef['type'], assigneeId?: number, extra: Partial<StepDef> = {}): StepDef =>
    ({ key: k, name, type, ...(assigneeId ? { assignee: { source: 'employee', id: assigneeId } } : {}), ...extra }) as StepDef;
  const borrowSteps = (extra: Partial<StepDef> = {}): StepDef[] => [
    step('apply', '提交申请', 'submit', undefined, { assignee: { source: 'requester' } }), step('approve', '审批', 'approval', boss1.id, { dueMinutes: 60, ...extra }),
    step('handover', '交接执照', 'execute', keeper.id), step('receive_back', '确认归还', 'execute', keeper.id), step('end', '结束', 'end'),
  ];
  const newLicense = async () => (await resources.create(admin, 'licenses', { category: 'operation', companyName: `公司${key()}`, creditCode: `FG-${key()}`, legalPerson: '王' })).id;
  const borrow = async (u: AuthUser = req) => flow.start(u, 'license-borrow', { licenseId: await newLicense(), item: 'original', borrower: '小张', purpose: '开店', borrowedAt: day, expectedReturnAt: '2026-03-20' });

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    resources = s.resources;
    flow = new FlowService(ds, resources, new FinanceDocumentsService(ds));
    timeout = new FlowTimeoutService(ds);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `g${crypto.randomBytes(5).toString('hex')}`, name: '缺口测试', status: 'active' }));
    companyId = c.id;
    const a = await mkUser('admin', '管理员', { isCompanyAdmin: true });
    admin = { id: a, companyId, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    req = au(await mkUser('req', '申请人'), '申请人');
    boss1 = au(await mkUser('boss1', '审批人'), '审批人');
    keeper = au(await mkUser('keeper', '保管人'), '保管人');
    other = au(await mkUser('other', '路人'), '路人');
  });
  afterAll(async () => { await ds?.destroy(); });

  const publishBorrow = async (u: AuthUser = admin, scope?: unknown, extra: Partial<StepDef> = {}) => {
    await flow.saveDraft(u, 'license-borrow', borrowSteps(extra), [], null, scope);
    return flow.publish(u, 'license-borrow');
  };
  const notices = (userId: number, kind: string) => ds.manager.count(Notification, { where: { userId, kind } });

  // ================= 缺口1：发起人范围 =================
  describe('发起人范围（缺口1）', () => {
    let deptA = 0, deptB = 0, posOps = 0, posFin = 0;
    let inA: AuthUser, inB: AuthUser, opsPerson: AuthUser, finPerson: AuthUser, grouped: AuthUser;
    beforeAll(async () => {
      deptA = (await ds.manager.save(Department, ds.manager.create(Department, { companyId, name: '运营部' }))).id;
      deptB = (await ds.manager.save(Department, ds.manager.create(Department, { companyId, name: '财务部' }))).id;
      posOps = (await ds.query('INSERT INTO positions (company_id, name, workspace_type) VALUES (?, ?, ?)', [companyId, '运营岗', 'operations'])).insertId;
      posFin = (await ds.query('INSERT INTO positions (company_id, name, workspace_type) VALUES (?, ?, ?)', [companyId, '财务岗', 'finance'])).insertId;
      inA = au(await mkUser('ina', '甲部门人', { departmentId: deptA }), '甲部门人');
      inB = au(await mkUser('inb', '乙部门人', { departmentId: deptB }), '乙部门人');
      opsPerson = au(await mkUser('opsp', '运营岗人', { positionId: posOps }), '运营岗人');
      finPerson = au(await mkUser('finp', '财务岗人', { positionId: posFin }), '财务岗人');
      grouped = au(await mkUser('grp', '职责组人'), '职责组人');
    });
    const startable = async (u: AuthUser) => (await flow.templates(u)).find((t: { key: string }) => t.key === 'license-borrow')!.startable as boolean;
    const tryStart = (u: AuthUser) => borrow(u);

    it('范围为空 = 不限制：和以前一样，有申请权限的人都能发起，入口都可见', async () => {
      await publishBorrow(admin, null);
      for (const u of [inA, inB, opsPerson, other]) { expect(await startable(u)).toBe(true); await expect(tryStart(u)).resolves.toBeDefined(); }
      await publishBorrow(admin, {}); // 空对象也是不限制
      expect(await startable(inB)).toBe(true);
    });

    it('按部门：范围内能发起，范围外看不到入口、接口也拒绝；公司管理员始终可以', async () => {
      await publishBorrow(admin, { departments: [deptA] });
      expect(await startable(inA)).toBe(true);
      await expect(tryStart(inA)).resolves.toBeDefined();
      expect(await startable(inB)).toBe(false);
      await expect(tryStart(inB)).rejects.toThrow(/发起人范围/);
      expect(await startable(other)).toBe(false); // 没有部门的人也不行
      await expect(tryStart(other)).rejects.toThrow(/发起人范围/);
      expect(await startable(admin)).toBe(true);
      await expect(tryStart(admin)).resolves.toBeDefined();
      // 权限缺失仍然先拒绝
      await expect(flow.start({ ...inA, permissions: { isCompanyAdmin: false, allow: [], deny: [] } }, 'license-borrow', { licenseId: await newLicense(), item: 'original', borrower: 'x', purpose: 'y', borrowedAt: day, expectedReturnAt: '2026-03-20' })).rejects.toThrow(/权限/);
    });

    it('按岗位、角色（岗位类型）、员工、职责组；多个来源取并集', async () => {
      await publishBorrow(admin, { positions: [posOps] });
      expect(await startable(opsPerson)).toBe(true); expect(await startable(finPerson)).toBe(false);
      await publishBorrow(admin, { positionTypes: ['finance'] });
      expect(await startable(finPerson)).toBe(true); expect(await startable(opsPerson)).toBe(false);
      await expect(tryStart(opsPerson)).rejects.toThrow(/发起人范围/);
      await publishBorrow(admin, { users: [other.id] });
      expect(await startable(other)).toBe(true); expect(await startable(inA)).toBe(false);
      // 职责组：成员关系来自资料“职责组成员”
      const mkRec = (type: string, title: string, data: Record<string, unknown>) => ds.manager.save(ResourceRecord, ds.manager.create(ResourceRecord, { companyId, type, title, status: 'normal', searchText: title, data } as never));
      const g = await mkRec('duty-groups', '发起组', { groupKey: `g${key()}`, name: '发起组' });
      await mkRec('duty-group-members', '成员', { groupId: g.id, userId: grouped.id });
      await publishBorrow(admin, { dutyGroups: [g.id] });
      expect(await startable(grouped)).toBe(true); expect(await startable(inA)).toBe(false);
      // 采购式配置：角色 + 多个部门
      await publishBorrow(admin, { positionTypes: ['finance'], departments: [deptA, deptB] });
      for (const u of [finPerson, inA, inB]) expect(await startable(u)).toBe(true);
      expect(await startable(opsPerson)).toBe(false);
    });

    it('随版本发布才生效：草稿里改范围不影响当前启用版本；保存校验引用必须是本公司真实存在的', async () => {
      await publishBorrow(admin, { departments: [deptA] });
      await flow.saveDraft(admin, 'license-borrow', borrowSteps(), [], null, { departments: [deptB] });
      expect(await startable(inA)).toBe(true); expect(await startable(inB)).toBe(false);
      const def = await flow.definition(admin, 'license-borrow');
      expect(def.active?.starterScope).toEqual({ departments: [deptA] });
      expect(def.draft.starterScope).toEqual({ departments: [deptB] });
      // 不传 = 沿用草稿里已有的
      await flow.saveDraft(admin, 'license-borrow', borrowSteps(), []);
      expect((await flow.definition(admin, 'license-borrow')).draft.starterScope).toEqual({ departments: [deptB] });
      await flow.publish(admin, 'license-borrow');
      expect(await startable(inB)).toBe(true); expect(await startable(inA)).toBe(false);
      // 新建草稿默认继承启用版本的范围
      await flow.saveDraft(admin, 'license-borrow', borrowSteps({ dueMinutes: 90 }), []);
      expect((await flow.definition(admin, 'license-borrow')).draft.starterScope).toEqual({ departments: [deptB] });
      await expect(flow.saveDraft(admin, 'license-borrow', borrowSteps(), [], null, { departments: [99999999] })).rejects.toThrow(/部门不存在/);
      await expect(flow.saveDraft(admin, 'license-borrow', borrowSteps(), [], null, { positions: [99999999] })).rejects.toThrow(/岗位不存在/);
      await expect(flow.saveDraft(admin, 'license-borrow', borrowSteps(), [], null, { users: [99999999] })).rejects.toThrow(/不存在或已停用/);
      await expect(flow.saveDraft(admin, 'license-borrow', borrowSteps(), [], null, { dutyGroups: [99999999] })).rejects.toThrow(/职责组不存在/);
      await expect(flow.saveDraft(admin, 'license-borrow', borrowSteps(), [], null, { positionTypes: ['ghost'] })).rejects.toThrow(/角色/);
      await expect(flow.saveDraft(admin, 'license-borrow', borrowSteps(), [], null, { evil: [1] })).rejects.toThrow(/不认识/);
      // 没有配置权限不能改范围
      await expect(flow.saveDraft(inA, 'license-borrow', borrowSteps(), [], null, { departments: [deptA] })).rejects.toThrow(/权限/);
      // 另一家公司的部门不能引用
      const c2 = await ds.manager.save(Company, ds.manager.create(Company, { code: `h${crypto.randomBytes(5).toString('hex')}`, name: '别家', status: 'active' }));
      const foreign = await ds.manager.save(Department, ds.manager.create(Department, { companyId: c2.id, name: '别家部门' }));
      await expect(flow.saveDraft(admin, 'license-borrow', borrowSteps(), [], null, { departments: [foreign.id] })).rejects.toThrow(/部门不存在/);
      await publishBorrow(admin, null); // 还原
    });
  });

  // ================= 缺口8：发布和保存草稿写审计 =================
  it('保存草稿、发布都写审计；版本记录里有发布人', async () => {
    const before = await ds.manager.count(AuditLog, { where: { companyId, action: 'flow.publish' } });
    await flow.saveDraft(admin, 'license-borrow', borrowSteps({ dueMinutes: 75 }), []);
    const draftLog = await ds.manager.findOneOrFail(AuditLog, { where: { companyId, action: 'flow.draft.save', resourceId: 'license-borrow' }, order: { id: 'DESC' } });
    expect(draftLog.actorId).toBe(admin.id);
    expect(draftLog.detail).toMatchObject({ stepCount: 5 });
    const r = await flow.publish(admin, 'license-borrow');
    expect(await ds.manager.count(AuditLog, { where: { companyId, action: 'flow.publish' } })).toBe(before + 1);
    const pubLog = await ds.manager.findOneOrFail(AuditLog, { where: { companyId, action: 'flow.publish', resourceId: 'license-borrow' }, order: { id: 'DESC' } });
    expect(pubLog.actorId).toBe(admin.id);
    expect(pubLog.detail).toMatchObject({ version: r.version, stepCount: 5 });
    const def = await flow.definition(admin, 'license-borrow');
    expect(def.history.find((h: { version: number }) => h.version === r.version)).toMatchObject({ publishedBy: admin.id, publishedByName: '管理员' });
    expect(def.active?.publishedBy).toBe(admin.id);
    // 发布失败（校验不过）不留发布审计
    await expect(flow.publish(admin, 'license-borrow')).rejects.toThrow(/没有可发布的草稿/);
    expect(await ds.manager.count(AuditLog, { where: { companyId, action: 'flow.publish' } })).toBe(before + 1);
  });

  // ================= 缺口7：批量改派 =================
  describe('批量改派（缺口7）', () => {
    let newApprover: AuthUser;
    beforeAll(async () => { newApprover = au(await mkUser('newb', '新审批人'), '新审批人'); });
    it('只有公司管理员能改派；必须写原因；先预览再改；写审计；新办理人能办、原办理人不能办', async () => {
      await publishBorrow(admin, null);
      const r1 = await borrow(), r2 = await borrow();
      const mine = async () => (await flow.todos(boss1, { tab: 'pending', page: 1, pageSize: 100 })).rows.filter((x: { runId: number }) => [r1.id, r2.id].includes(x.runId)).length;
      expect(await mine()).toBe(2);
      await expect(flow.reassignOpen(boss1, { fromUserId: boss1.id, toUserId: newApprover.id, reason: '换人' })).rejects.toThrow(/公司管理员/);
      await expect(flow.reassignOpen(admin, { fromUserId: boss1.id, toUserId: newApprover.id, reason: '' })).rejects.toThrow(/原因/);
      await expect(flow.reassignOpen(admin, { fromUserId: boss1.id, toUserId: boss1.id, reason: '换人' })).rejects.toThrow(/同一个人/);
      await expect(flow.reassignOpen(admin, { fromUserId: boss1.id, toUserId: 99999999, reason: '换人' })).rejects.toThrow(/不存在或已停用/);
      const dry = await flow.reassignOpen(admin, { fromUserId: boss1.id, toUserId: newApprover.id, dryRun: true });
      expect(dry.count).toBeGreaterThanOrEqual(2);
      expect(await mine()).toBe(2); // 预览不改
      const dueBefore = (await ds.manager.findOneOrFail(WorkItem, { where: { runId: r1.id, status: 'open' } })).dueAt;
      const out = await flow.reassignOpen(admin, { fromUserId: boss1.id, toUserId: newApprover.id, templateKey: 'license-borrow', stepKey: 'approve', reason: '审批人离职交接' });
      expect(out.moved).toBeGreaterThanOrEqual(2);
      expect(out.skipped).toEqual([]);
      expect(await mine()).toBe(0);
      const item = await ds.manager.findOneOrFail(WorkItem, { where: { runId: r1.id, status: 'open' } });
      expect(item.assigneeId).toBe(newApprover.id);
      expect(item.dueAt?.getTime()).toBe(dueBefore?.getTime()); // 截止时间不变
      const d1 = await flow.detail(newApprover, r1.id);
      expect(d1.activeStep!.recipients.map((x) => x.name)).toEqual(['新审批人']);
      expect(d1.events.some((e) => e.action === 'transfer' && /批量改派/.test(e.note ?? '') && /审批人离职交接/.test(e.note ?? ''))).toBe(true);
      await expect(flow.pass(boss1, r1.id, { revision: d1.revision, stepId: d1.activeStep!.id })).rejects.toThrow(/不是你办理|刷新/);
      const passed = await flow.pass(newApprover, r1.id, { revision: d1.revision, stepId: d1.activeStep!.id, comment: '接手办理' });
      expect(passed.activeStep?.key).toBe('handover');
      expect(await notices(newApprover.id, 'todo')).toBeGreaterThanOrEqual(2);
      expect(await notices(boss1.id, 'transfer')).toBeGreaterThanOrEqual(2);
      const log = await ds.manager.findOneOrFail(AuditLog, { where: { companyId, action: 'flow.reassign' }, order: { id: 'DESC' } });
      expect(log.actorId).toBe(admin.id);
      expect(log.detail).toMatchObject({ fromUserId: boss1.id, toUserId: newApprover.id, reason: '审批人离职交接' });
      expect((log.detail as { movedRunIds: number[] }).movedRunIds).toEqual(expect.arrayContaining([r1.id, r2.id]));
      // 别公司的人不能被改派
      const c2 = await ds.manager.save(Company, ds.manager.create(Company, { code: `h${crypto.randomBytes(5).toString('hex')}`, name: '别家2', status: 'active' }));
      const foreign = await ds.manager.save(User, ds.manager.create(User, { companyId: c2.id, account: `fx${key()}`, passwordHash: 'x', name: '外人', status: 'active', mustChangePassword: false }));
      await expect(flow.reassignOpen(admin, { fromUserId: foreign.id, toUserId: newApprover.id, reason: '越权' })).rejects.toThrow(/不存在/);
    });
    it('部门共享的步骤只换掉这个人的那一份待办；新办理人已在名单里时只收回原办理人的', async () => {
      const mate = au(await mkUser('mate', '同事乙'), '同事乙');
      const dept = (await ds.manager.save(Department, ds.manager.create(Department, { companyId, name: '共享部' }))).id;
      await ds.query('UPDATE users SET department_id = ? WHERE id IN (?, ?)', [dept, boss1.id, mate.id]);
      await flow.saveDraft(admin, 'license-borrow', [
        step('apply', '提交申请', 'submit', undefined, { assignee: { source: 'requester' } }), { key: 'approve', name: '审批', type: 'approval', assignee: { source: 'department', id: dept } } as StepDef,
        step('handover', '交接执照', 'execute', keeper.id), step('receive_back', '确认归还', 'execute', keeper.id), step('end', '结束', 'end'),
      ], []);
      await flow.publish(admin, 'license-borrow');
      const run = await borrow();
      expect((await flow.detail(admin, run.id)).activeStep!.recipients.map((x) => x.name).sort()).toEqual(['同事乙', '审批人']);
      await flow.reassignOpen(admin, { fromUserId: boss1.id, toUserId: mate.id, reason: '同事已在名单里' });
      const items = await ds.manager.find(WorkItem, { where: { runId: run.id } });
      expect(items.filter((i) => i.status === 'open').map((i) => i.assigneeId)).toEqual([mate.id]);
      expect(items.filter((i) => i.status === 'cancelled').map((i) => i.assigneeId)).toEqual([boss1.id]);
      const d = await flow.detail(mate, run.id);
      expect(d.activeStep!.recipients.map((x) => x.name)).toEqual(['同事乙']);
      await publishBorrow(admin, null);
    });
  });

  // ================= 缺口9：逾期扫描 =================
  describe('逾期扫描（缺口9）', () => {
    it('复现：待办很多时（>500 条没逾期或已通知过），新逾期的待办不能被前 500 条挤掉', async () => {
      const past = new Date(Date.now() - 3600_000), future = new Date(Date.now() + 86400_000);
      await ds.manager.insert(WorkItem, Array.from({ length: 520 }, (_, i) => ({ companyId, kind: 'task', assigneeId: other.id, title: `旧已通知${i}`, status: 'open', dueAt: past, overdueNotifiedAt: new Date() })) as never);
      await ds.manager.insert(WorkItem, Array.from({ length: 520 }, (_, i) => ({ companyId, kind: 'task', assigneeId: other.id, title: `没到期${i}`, status: 'open', dueAt: future })) as never);
      const fresh = await ds.manager.save(WorkItem, ds.manager.create(WorkItem, { companyId, kind: 'task', assigneeId: other.id, title: '新逾期的一条', status: 'open', dueAt: past }));
      const n = await flow.scanOverdue(new Date());
      expect(n).toBeGreaterThanOrEqual(1);
      const after = await ds.manager.findOneOrFail(WorkItem, { where: { id: fresh.id } });
      expect(after.overdueNotifiedAt).not.toBeNull();
      expect(await ds.manager.count(Notification, { where: { userId: other.id, kind: 'overdue' } })).toBe(1);
    });

    it('去重：配了督促超时提醒的节点，办理人不再重复收到“已逾期”；没配的照发（逾期扫描）', async () => {
      await publishBorrow(admin, null, { remind: { beforeMinutes: [20], overdueEveryMinutes: 5 } });
      const withRemind = await borrow();
      await publishBorrow(admin, null);
      const plain = await borrow();
      const later = new Date(Date.now() + 3 * 3600_000);
      const c0 = await notices(boss1.id, 'overdue');
      await flow.scanOverdue(later);
      const items = await ds.manager.find(WorkItem, { where: { runId: In([withRemind.id, plain.id]), status: 'open' } });
      expect(items.every((i) => i.overdueNotifiedAt)).toBe(true); // 都扫过了，不会反复扫
      const got = (await notices(boss1.id, 'overdue')) - c0;
      expect(got).toBe(1); // 只有没配督促的那条发了“已逾期”
      const t = (await ds.manager.find(Notification, { where: { userId: boss1.id, kind: 'overdue' }, order: { id: 'DESC' }, take: 1 }))[0];
      expect(t.title).toContain(plain.title);
    });

    it('去重：逾期扫描的升级对象、主管、老板是同一个人时，同一个待办只收一条升级提醒；办理人本人不收升级', async () => {
      const lead = au(await mkUser(`lead${key().slice(0, 4)}`, '主管老板'), '主管老板');
      await flow.saveDraft(admin, 'license-borrow', borrowSteps(), [lead.id, boss1.id]); // 升级对象含主管，也含办理人本人
      await flow.publish(admin, 'license-borrow');
      await timeout.savePolicy(admin, '', '', { notifications: { enabled: true, supervisorAfterMinutes: 1, bossAfterMinutes: 2, supervisorReceiver: 'employee', supervisorUserId: lead.id, bossReceiver: 'employee', bossUserId: lead.id }, penalties: null }, (await timeout.getPolicy(admin, '', '')).revision);
      const run = await borrow();
      const later = new Date(Date.now() + 5 * 3600_000);
      const forRun = (uid: number) => ds.manager.count(Notification, { where: { userId: uid, kind: 'escalate', link: `/flow/overview?run=${run.id}` } });
      await flow.scanOverdue(later);
      await timeout.tick(later);
      await timeout.tick(new Date(later.getTime() + 60_000));
      expect(await forRun(lead.id)).toBe(1);
      expect(await forRun(boss1.id)).toBe(0);
      // 台账事件仍然记录了两级通知（第二级被去重）
      const ev = await ds.query("SELECT after_json AS a FROM flow_timeout_events e JOIN flow_timeout_incidents i ON i.id = e.ref_id WHERE e.kind = 'escalate' AND i.run_id = ? ORDER BY e.id", [run.id]);
      const parsed = ev.map((r: { a: unknown }) => (typeof r.a === 'string' ? JSON.parse(r.a) : r.a));
      expect(parsed.map((x: { level: string }) => x.level)).toEqual(['supervisor', 'boss']);
      expect(parsed[1].dedupedIds).toEqual([lead.id]);
      await publishBorrow(admin, null);
      await timeout.savePolicy(admin, '', '', { notifications: { enabled: false, supervisorAfterMinutes: 15, bossAfterMinutes: 30, supervisorReceiver: 'manager', supervisorUserId: null, bossReceiver: 'admins', bossUserId: null }, penalties: null }, (await timeout.getPolicy(admin, '', '')).revision);
    });
  });
});
