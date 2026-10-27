/** 流程目录与自建模板、超时与处罚的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_u6 npx jest flow-designer */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { defaultTimeoutPolicy, type CustomSchema, type StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Department, User } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { FlowDesignerService } from './flow-designer.service';
import { FlowTimeoutService } from './flow-timeout.service';
import { FlowService } from './flow.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('流程目录、自建模板与超时处罚（真实数据库）', () => {
  let ds: DataSource;
  let flow: FlowService, designer: FlowDesignerService, timeout: FlowTimeoutService;
  let admin: AuthUser, req: AuthUser, boss: AuthUser, fin: AuthUser, wh1: AuthUser, wh2: AuthUser, lead: AuthUser, other: AuthUser;
  let deptId = 0, otherCompanyAdmin: AuthUser;
  const au = (id: number, companyId: number, name: string, allow: string[] = []): AuthUser => ({ id, companyId, name, permissions: { isCompanyAdmin: false, allow: ['flow.apply.view', ...allow], deny: [] } });
  const mk = async (companyId: number, account: string, name: string, extra: Partial<User> = {}) =>
    (await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra }))).id;
  const emp = (id: number) => ({ source: 'employee' as const, id });
  const schema = (): CustomSchema => ({
    fields: [
      { key: 'title', label: '事项', type: 'text', group: '申请', required: true },
      { key: 'amount', label: '金额', type: 'money', group: '申请', required: true },
    ],
    stepFields: { pay: [{ key: 'voucher', label: '凭证号', type: 'text', group: '付款' }] },
    posting: null,
  });
  const steps = (): StepDef[] => [
    { key: 'apply', name: '提交申请', type: 'submit', assignee: { source: 'requester' } },
    { key: 'boss', name: '老板审批', type: 'approval', assignee: emp(boss.id), dueMinutes: 60, when: { field: 'payload.amount', op: 'gte', value: 100000 } },
    { key: 'pay', name: '付款', type: 'finance', assignee: emp(fin.id), dueMinutes: 120 },
    { key: 'end', name: '结束', type: 'end' },
  ];
  const make = async (name: string, st: StepDef[] = steps(), sc: CustomSchema = schema()) => {
    const { key } = await designer.create(admin, { name, departmentId: deptId });
    const keys = new Set(st.map((x) => x.key));
    const sc2: CustomSchema = { ...sc, stepFields: Object.fromEntries(Object.entries(sc.stepFields).filter(([k]) => keys.has(k))) };
    await flow.saveDraft(admin, key, st, [], sc2);
    await flow.publish(admin, key);
    return key;
  };
  const rid = () => crypto.randomBytes(4).toString('hex');

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    flow = new FlowService(ds, s.resources, new FinanceDocumentsService(ds));
    designer = new FlowDesignerService(ds, flow);
    timeout = new FlowTimeoutService(ds);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `d${crypto.randomBytes(5).toString('hex')}`, name: '设计器测试', status: 'active' }));
    const dep = await ds.manager.save(Department, ds.manager.create(Department, { companyId: c.id, name: '运营部', status: 'active' } as never));
    deptId = dep.id;
    const a = await mk(c.id, 'admin', '管理员', { isCompanyAdmin: true });
    admin = { id: a, companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const leadId = await mk(c.id, 'lead', '主管');
    lead = au(leadId, c.id, '主管');
    req = au(await mk(c.id, 'req', '申请人', { managerId: leadId }), c.id, '申请人');
    boss = au(await mk(c.id, 'boss', '老板'), c.id, '老板');
    fin = au(await mk(c.id, 'fin', '出纳'), c.id, '出纳');
    wh1 = au(await mk(c.id, 'wh1', '仓库一', { departmentId: deptId }), c.id, '仓库一');
    wh2 = au(await mk(c.id, 'wh2', '仓库二', { departmentId: deptId }), c.id, '仓库二');
    other = au(await mk(c.id, 'oth', '路人'), c.id, '路人');
    const c2 = await ds.manager.save(Company, ds.manager.create(Company, { code: `e${crypto.randomBytes(5).toString('hex')}`, name: '别家', status: 'active' }));
    otherCompanyAdmin = { id: await mk(c2.id, 'admin2', '别家管理员', { isCompanyAdmin: true }), companyId: c2.id, name: '别家管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('新建自建模板：默认草稿、不能同名；没有配置权限不能建；别的公司看不到', async () => {
    await expect(designer.create(req, { name: '无权' })).rejects.toThrow(/权限/);
    const { key } = await designer.create(admin, { name: '采购审批', departmentId: deptId });
    await expect(designer.create(admin, { name: '采购审批' })).rejects.toThrow(/已经有/);
    await expect(designer.create(admin, { name: '坏部门', departmentId: 99999999 })).rejects.toThrow(/部门/);
    const dir = await designer.directory(admin);
    const row = dir.templates.find((t) => t.key === key)!;
    expect(row).toMatchObject({ custom: true, status: 'inactive', departmentName: '运营部', stepCount: 1 });
    expect(row.issues.join()).toContain('办理人'); // 审批步还没选办理人
    expect((await designer.directory(otherCompanyAdmin)).templates.some((t) => t.key === key)).toBe(false);
    await expect(flow.definition(otherCompanyAdmin, key)).rejects.toThrow(/没有这种流程/);
    // 未启用不出现在申请中心，也不能发起
    expect((await flow.templates(req)).some((t: { key: string }) => t.key === key)).toBe(false);
    await expect(flow.start(req, key, {})).rejects.toThrow(/还没有启用/);
  });

  it('条件分支：金额小于 1000 元跳过老板审批，大于等于走老板；跳过的步骤留记录', async () => {
    const key = await make(`条件流程${rid()}`);
    expect((await flow.templates(req)).some((t: { key: string }) => t.key === key)).toBe(true);
    const small = await flow.start(req, key, { title: '小额', amount: 50000 });
    expect(small.activeStep?.key).toBe('pay');
    expect(small.steps.find((s) => s.key === 'boss')?.status).toBe('skipped');
    const big = await flow.start(req, key, { title: '大额', amount: 200000 });
    expect(big.activeStep?.key).toBe('boss');
    const done = await flow.pass(boss, big.id, { revision: big.revision, stepId: big.activeStep!.id });
    expect(done.activeStep?.key).toBe('pay');
    const fin2 = await flow.pass(fin, done.id, { revision: done.revision, stepId: done.activeStep!.id, form: { voucher: 'V1' } });
    expect(fin2.status).toBe('completed');
    // 退回：付款退回时，小额单跳过了老板，所以回到发起人
    const back = await flow.returnBack(fin, small.id, { revision: small.revision, stepId: small.activeStep!.id, reason: '资料不全' });
    expect(back.activeStep?.key).toBe('apply');
    expect(await designer.directory(admin).then((x) => x.templates.find((t) => t.key === key)!.runCount)).toBe(2);
  });

  it('退回目标、会签、发起人的上级、上一步办理人', async () => {
    const st: StepDef[] = [
      { key: 'apply', name: '提交申请', type: 'submit', assignee: { source: 'requester' } },
      { key: 'mgr', name: '主管审', type: 'approval', assignee: { source: 'requester_manager' } },
      { key: 'check', name: '仓库会签', type: 'execute', assignee: { source: 'department', id: deptId }, mode: 'all' },
      { key: 'again', name: '上一步人复核', type: 'approval', assignee: { source: 'previous_handler' }, returnToKey: 'mgr' },
      { key: 'end', name: '结束', type: 'end' },
    ];
    const key = await make(`会签流程${rid()}`, st);
    const run = await flow.start(req, key, { title: 'x', amount: 1 });
    expect(run.activeStep?.recipients.map((r) => r.name)).toEqual(['主管']);
    const r2 = await flow.pass(lead, run.id, { revision: run.revision, stepId: run.activeStep!.id });
    expect(r2.activeStep?.key).toBe('check');
    expect(r2.activeStep?.recipients.map((r) => r.name).sort()).toEqual(['仓库一', '仓库二']);
    const mid = await flow.pass(wh1, run.id, { revision: r2.revision, stepId: r2.activeStep!.id, comment: '一号通过' });
    expect(mid.activeStep?.key).toBe('check'); // 还要等仓库二
    await expect(flow.pass(wh1, run.id, { revision: mid.revision, stepId: mid.activeStep!.id })).rejects.toThrow(/不是你办理/);
    const r3 = await flow.pass(wh2, run.id, { revision: mid.revision, stepId: mid.activeStep!.id });
    expect(r3.activeStep?.key).toBe('again');
    expect(r3.activeStep?.recipients.map((r) => r.name)).toEqual(['仓库二']); // 上一步是仓库二办完的
    const back = await flow.returnBack(wh2, run.id, { revision: r3.revision, stepId: r3.activeStep!.id, reason: '不对' });
    expect(back.activeStep?.key).toBe('mgr'); // 声明的退回目标
    // 发起人没有上级时，发布后发起会失败并提示
    const noBoss = au(await mk(admin.companyId, `nb${rid()}`, '无上级'), admin.companyId, '无上级');
    await expect(flow.start(noBoss, key, { title: 'y', amount: 1 })).rejects.toThrow(/上级/);
  });

  it('字段权限：办理人看不到隐藏的发起字段，发起人和总览权限的人看得到（服务端过滤）', async () => {
    const st = steps();
    st[2] = { ...st[2], hiddenFields: ['amount'] };
    const key = await make(`隐藏字段${rid()}`, st);
    const run = await flow.start(req, key, { title: '秘密', amount: 50000 });
    const asFin = await flow.detail(fin, run.id);
    expect(asFin.payload).toEqual({ title: '秘密' });
    expect(asFin.fields.map((f) => f.key)).toEqual(['title']);
    expect(JSON.stringify(asFin.refLabels)).not.toContain('amount');
    expect((await flow.detail(req, run.id)).payload.amount).toBe(50000);
  });

  it('版本：改了模板不影响在途流程；停用后不能发起；可回退启用旧版本', async () => {
    const key = await make(`版本流程${rid()}`);
    const old = await flow.start(req, key, { title: '旧', amount: 10 });
    // v2：加一个字段、去掉付款步骤
    const sc2 = schema();
    sc2.fields.push({ key: 'extra', label: '新字段', type: 'text', group: '申请', required: true });
    const st2 = steps().filter((s) => s.key !== 'pay');
    st2[1] = { ...st2[1], when: null } as StepDef;
    delete sc2.stepFields.pay;
    await flow.saveDraft(admin, key, st2, [], sc2);
    await flow.publish(admin, key);
    const def = await flow.definition(admin, key);
    expect(def.active?.version).toBe(2);
    expect(def.history.map((h) => h.status)).toEqual(['active', 'retired']);
    // 旧流程仍按 v1 的表单结构和步骤走
    const oldDetail = await flow.detail(req, old.id);
    expect(oldDetail.fields.map((f) => f.key)).toEqual(['title', 'amount']);
    expect(oldDetail.activeStep?.key).toBe('pay');
    // 新流程缺新字段就报错
    await expect(flow.start(req, key, { title: '新', amount: 10 })).rejects.toThrow(/新字段/);
    const fresh = await flow.start(req, key, { title: '新', amount: 10, extra: 'ok' });
    expect(fresh.activeStep?.key).toBe('boss');
    // 停用
    await designer.deactivate(admin, key);
    await expect(flow.start(req, key, { title: '新', amount: 10, extra: 'ok' })).rejects.toThrow(/还没有启用/);
    expect((await designer.directory(admin)).templates.find((t) => t.key === key)).toMatchObject({ status: 'inactive', everPublished: true });
    await expect(designer.deactivate(admin, key)).rejects.toThrow(/没有在启用/);
    // 在办的不受影响
    const still = await flow.pass(fin, old.id, { revision: oldDetail.revision, stepId: oldDetail.activeStep!.id });
    expect(still.status).toBe('completed');
    // 回退到 v1
    await designer.activate(admin, key, 1);
    expect((await flow.definition(admin, key)).active?.version).toBe(1);
    await expect(designer.activate(admin, key, 1)).rejects.toThrow(/已经在启用/);
    await expect(designer.activate(admin, key, 9)).rejects.toThrow(/发布过/);
  });

  it('复制与删除：复制内置模板得到自建模板；有申请的不能删，没用过的能删；内置不能删', async () => {
    const { key } = await designer.create(admin, { name: `复制的借用${rid()}`, sourceKey: 'license-borrow' });
    const def = await flow.definition(admin, key);
    expect(def.template.custom).toBe(true);
    expect(def.draft.steps.map((s) => s.key)).toEqual(['apply', 'approve', 'handover', 'receive_back', 'end']);
    expect(def.draft.steps.every((s) => !s.locked)).toBe(true);
    expect(def.draft.schema?.fields.map((f) => f.key)).toContain('licenseId');
    const sku = await designer.create(admin, { name: `复制的SKU${rid()}`, sourceKey: 'sku-batch-apply' });
    const skuDef = await flow.definition(admin, sku.key);
    expect(skuDef.draft.schema?.fields.some((f) => f.type === 'json')).toBe(false); // 规格清单是内置专用控件，不复制
    const used = await make(`有历史${rid()}`);
    await flow.start(req, used, { title: 'a', amount: 1 });
    await expect(designer.remove(admin, used)).rejects.toThrow(/不能删除/);
    await designer.remove(admin, key);
    await expect(flow.definition(admin, key)).rejects.toThrow(/没有这种流程/);
    await expect(designer.remove(admin, 'license-borrow')).rejects.toThrow(/内置流程不支持/);
    await expect(designer.remove(req, used)).rejects.toThrow(/权限/);
    await expect(designer.discardDraft(admin, sku.key)).rejects.toThrow(/第一个草稿/);
  });

  it('自建模板的发布检查：表单、条件、办理人都要合法，错的发布不了也保存不了', async () => {
    const { key } = await designer.create(admin, { name: `检查${rid()}` });
    const bad = steps();
    bad[1] = { ...bad[1], when: { field: 'payload.nope', op: 'eq', value: 1 } };
    await expect(flow.saveDraft(admin, key, bad, [], schema())).rejects.toThrow(/不存在/);
    const noPerson = steps(); noPerson[2] = { ...noPerson[2], assignee: { source: 'position', id: 99999 } };
    await flow.saveDraft(admin, key, noPerson, [], schema());
    await expect(flow.publish(admin, key)).rejects.toThrow(/岗位/);
    await expect(flow.saveDraft(req, key, steps(), [], schema())).rejects.toThrow(/权限/);
  });

  it('督促时效：到期前提醒、超时后按间隔提醒，每条只发一次', async () => {
    const st = steps();
    st[1] = { ...st[1], when: null, dueMinutes: 60, remind: { beforeMinutes: [20, 10], overdueEveryMinutes: 5 } } as StepDef;
    const key = await make(`督促${rid()}`, st);
    const run = await flow.start(req, key, { title: '催', amount: 1 });
    const now = new Date();
    const setDue = (mins: number) => ds.query("UPDATE work_items SET due_at = ? WHERE run_id = ? AND status = 'open'", [new Date(now.getTime() + mins * 60_000), run.id]);
    const count = async () => Number((await ds.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'remind'", [boss.id]))[0].n);
    // 测试库里可能留有别的测试遗留的待办，所以只看本流程办理人收到的提醒数
    const step = async () => { const c0 = await count(); await timeout.reminders(now); return (await count()) - c0; };
    await setDue(15);
    expect(await step()).toBe(1);
    expect(await step()).toBe(0); // 同一提醒不重复
    await setDue(8);
    expect(await step()).toBe(1);
    await setDue(-12);
    expect(await step()).toBe(1); // 超时 12 分钟 = 第 2 个 5 分钟周期
    expect(await step()).toBe(0);
  });

  it('超时规则三层覆盖、版本冲突、权限；超时事件通知主管并计算处罚，确认/免除要权限和原因', async () => {
    await expect(timeout.savePolicy(req, '', '', defaultTimeoutPolicy(), 0)).rejects.toThrow(/权限/);
    const pol = defaultTimeoutPolicy();
    pol.notifications = { ...pol.notifications, enabled: true, supervisorAfterMinutes: 10, bossAfterMinutes: 30 };
    pol.penalties = { ...pol.penalties, enabled: true, afterMinutes: 5, mode: 'repeat', unit: 'task', amountCents: 500, repeatMinutes: 10, repeatAmountCents: 100, capCents: 2000 };
    const saved = await timeout.savePolicy(admin, '', '', pol, 0);
    expect(saved.revision).toBe(1);
    await expect(timeout.savePolicy(admin, '', '', pol, 0)).rejects.toThrow(/已被修改/);
    const bad = { notifications: { ...pol.notifications, supervisorAfterMinutes: 50, bossAfterMinutes: 10 }, penalties: pol.penalties };
    await expect(timeout.savePolicy(admin, '', '', bad, 1)).rejects.toThrow(/老板通知阈值/);

    const key = await make(`处罚${rid()}`);
    const run = await flow.start(req, key, { title: '超时', amount: 1 });
    await expect(timeout.savePolicy(admin, key, 'nope', { notifications: null, penalties: null }, 0)).rejects.toThrow(/节点不存在/);
    // 节点独立规则覆盖封顶
    const node = { notifications: null, penalties: { ...pol.penalties, capCents: 800 } };
    await timeout.savePolicy(admin, key, 'pay', node, 0);
    const eff = await timeout.getPolicy(admin, key, 'pay');
    expect(eff.effective.sources.penalties).toBe('节点独立');
    expect(eff.effective.sources.notifications).toBe('公司默认');

    // 付款待办超时 35 分钟：5 分钟起罚 500，之后每 10 分钟 +100 → 500+300=800（封顶 800）
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    await ds.query("UPDATE work_items SET due_at = ? WHERE run_id = ? AND status = 'open'", [new Date(now.getTime() - 35 * 60_000), run.id]);
    (timeout as unknown as { policyRows: Map<number, unknown> }).policyRows.clear();
    expect(await timeout.incidents(now)).toBeGreaterThanOrEqual(1);
    await timeout.incidents(now); // 重复扫描不重复建
    const ledger = await timeout.ledger(admin, { templateKey: key, page: 1 });
    expect(ledger.total).toBe(1);
    const row = ledger.rows[0] as Record<string, unknown> & { notifications: Array<{ level: string; recipientIds: number[]; error: string | null }> };
    expect(row).toMatchObject({ assigneeName: '出纳', soleOwner: true, status: 'open', calculatedCents: 800, penaltyStatus: 'pending' });
    expect(row.overdueMinutes).toBe(35);
    // 主管：出纳没有上级也没有部门主管 → 记录“未找到”；老板：公司管理员
    expect(row.notifications.find((n) => n.level === 'supervisor')?.error).toMatch(/未找到/);
    expect(row.notifications.find((n) => n.level === 'boss')?.recipientIds).toEqual([admin.id]);

    // 只有 flow.penalties.manage 能确认
    const pid = Number(row.penaltyId), rev = Number(row.penaltyRevision);
    await expect(timeout.decidePenalty(admin as AuthUser, pid, { status: 'confirmed', amountCents: 800, reason: '确认', revision: rev })).resolves.toBeDefined(); // 管理员天然有所有权限
    await expect(timeout.decidePenalty(admin, pid, { status: 'waived', amountCents: 0, reason: '重复', revision: rev + 1 })).rejects.toThrow(/已被处理/);
    const after = await timeout.ledger(admin, { templateKey: key, status: 'confirmed', page: 1 });
    expect(after.rows[0]).toMatchObject({ penaltyStatus: 'confirmed', confirmedCents: 800 });
    await expect(timeout.decidePenalty(other, pid, { status: 'waived', amountCents: 0, reason: 'x', revision: 1 })).rejects.toThrow(/权限/);
    // 办完后收口：事件变成已结束，处罚不再变化
    const cur = await flow.detail(fin, run.id);
    await flow.pass(fin, run.id, { revision: cur.revision, stepId: cur.activeStep!.id });
    await timeout.incidents(new Date(now.getTime() + 60_000));
    const closed = await timeout.ledger(admin, { templateKey: key, page: 1 });
    expect(closed.rows[0]).toMatchObject({ status: 'closed', penaltyStatus: 'confirmed' });
  });

  it('部门共享的步骤（多人收件）逾期只记事件，不计处罚', async () => {
    const st: StepDef[] = [
      { key: 'apply', name: '提交申请', type: 'submit', assignee: { source: 'requester' } },
      { key: 'wh', name: '仓库处理', type: 'execute', assignee: { source: 'department', id: deptId }, dueMinutes: 30 },
      { key: 'end', name: '结束', type: 'end' },
    ];
    const key = await make(`共享${rid()}`, st);
    const run = await flow.start(req, key, { title: '共享', amount: 1 });
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    await ds.query("UPDATE work_items SET due_at = ? WHERE run_id = ? AND status = 'open'", [new Date(now.getTime() - 120 * 60_000), run.id]);
    (timeout as unknown as { policyRows: Map<number, unknown> }).policyRows.clear();
    await timeout.incidents(now);
    const ledger = await timeout.ledger(admin, { templateKey: key, page: 1 });
    expect(ledger.total).toBe(2); // 两个收件人各一条事件
    expect(ledger.rows.every((r: { soleOwner: boolean; penaltyId: unknown }) => !r.soleOwner && !r.penaltyId)).toBe(true);
  });

  it('节点模板：内置只读可复制；自己的模板改动带版本号；重名/非法字段被拒', async () => {
    const list = await designer.nodeTemplates(admin);
    expect(list.templates.some((t) => t.builtin && t.key === 'approval')).toBe(true);
    expect(list.business.some((b) => b.flowLabel === '借用营业执照/印章' && b.name === '交接执照')).toBe(true);
    const input = { name: `加急审批${rid()}`, description: '大额', category: '通用节点', type: 'approval', dueMinutes: 120, fields: [{ key: 'note', label: '意见', type: 'text', group: '审批' }] };
    const a = await designer.saveNodeTemplate(admin, { ...input, sourceKey: 'approval' } as never);
    await expect(designer.saveNodeTemplate(admin, { ...input } as never)).rejects.toThrow(/已经有/);
    await expect(designer.saveNodeTemplate(admin, { ...input, name: '审批确认' } as never)).rejects.toThrow(/已经有/);
    await expect(designer.saveNodeTemplate(admin, { ...input, name: `x${rid()}`, fields: [{ key: 'Bad Key', label: '坏', type: 'text', group: 'x' }] } as never)).rejects.toThrow(/编号/);
    const b = await designer.saveNodeTemplate(admin, { ...input, key: a.key, revision: 1, dueMinutes: 60 } as never);
    expect(b.revision).toBe(2);
    await expect(designer.saveNodeTemplate(admin, { ...input, key: a.key, revision: 1 } as never)).rejects.toThrow(/已被别人修改/);
    await expect(designer.saveNodeTemplate(admin, { ...input, key: 'approval', revision: 0 } as never)).rejects.toThrow(/不存在/);
    await expect(designer.saveNodeTemplate(req, { ...input, name: `y${rid()}` } as never)).rejects.toThrow(/权限/);
    expect((await designer.nodeTemplates(otherCompanyAdmin)).templates.some((t) => t.key === a.key)).toBe(false);
    await designer.deleteNodeTemplate(admin, a.key);
    await expect(designer.deleteNodeTemplate(admin, a.key)).rejects.toThrow(/不存在/);
  });
});
