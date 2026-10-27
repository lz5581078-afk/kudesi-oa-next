/** 流程引擎的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test npx jest flow */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { FLOW_TEMPLATES, validatePostingDecl, type FlowTemplate, type StepDef } from '@kudesi/shared';
import { FLOW_ADAPTERS } from './flow-adapters';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Notification, User, WorkItem } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { FlowService } from './flow.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('流程引擎（真实数据库）', () => {
  let ds: DataSource;
  let flow: FlowService;
  let docs: FinanceDocumentsService;
  let resources: ReturnType<typeof buildServices>['resources'];
  let admin: AuthUser, req: AuthUser, boss1: AuthUser, keeper: AuthUser, fin: AuthUser, stranger: AuthUser;
  const ids: Record<string, number> = {};
  const day = '2026-03-10';
  const key = () => crypto.randomBytes(8).toString('hex') + 'abcd';

  const mkUser = async (companyId: number, account: string, name: string, extra: Partial<User> = {}) =>
    (await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra }))).id;
  const au = (id: number, companyId: number, name: string, allow: string[] = []): AuthUser => ({ id, companyId, name, permissions: { isCompanyAdmin: false, allow: ['flow.apply.view', ...allow], deny: [] } });

  const step = (key: string, name: string, type: StepDef['type'], assigneeId?: number, extra: Partial<StepDef> = {}): StepDef =>
    ({ key, name, type, ...(assigneeId ? { assignee: { source: 'employee', id: assigneeId } } : {}), ...extra }) as StepDef;
  const publishBorrow = async () => {
    await flow.saveDraft(admin, 'license-borrow', [
      step('apply', '提交申请', 'submit', undefined, { assignee: { source: 'requester' } }), step('approve', '审批', 'approval', boss1.id, { dueMinutes: 60 }),
      step('handover', '交接执照', 'execute', keeper.id, { ccUserIds: [stranger.id] }), step('receive_back', '确认归还', 'execute', keeper.id), step('end', '结束', 'end'),
    ], [boss1.id]);
    await flow.publish(admin, 'license-borrow');
  };
  const borrowPayload = (over: Record<string, unknown> = {}) => ({ licenseId: ids.lic, item: 'original', borrower: '小张', purpose: '开店', borrowedAt: day, expectedReturnAt: '2026-03-20', ...over });
  const refresh = async (u: AuthUser, id: number) => flow.detail(u, id);

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    resources = s.resources;
    docs = new FinanceDocumentsService(ds);
    flow = new FlowService(ds, resources, docs);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `f${crypto.randomBytes(5).toString('hex')}`, name: '流程测试', status: 'active' }));
    const a = await mkUser(c.id, 'admin', '管理员', { isCompanyAdmin: true });
    admin = { id: a, companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    req = au(await mkUser(c.id, 'req', '申请人'), c.id, '申请人', ['workbench.started.view']);
    boss1 = au(await mkUser(c.id, 'boss1', '审批人'), c.id, '审批人');
    keeper = au(await mkUser(c.id, 'keeper', '保管人'), c.id, '保管人');
    fin = au(await mkUser(c.id, 'fin', '出纳'), c.id, '出纳');
    stranger = au(await mkUser(c.id, 'str', '路人'), c.id, '路人');
    ids.lic = (await resources.create(admin, 'licenses', { category: 'operation', companyName: '流程公司', creditCode: `FLOW-${key()}`, legalPerson: '王' })).id;
    ids.feeOut = (await resources.create(admin, 'finance-fee-items', { name: '房租', direction: 'expense' })).id;
    ids.feeIn = (await resources.create(admin, 'finance-fee-items', { name: '废品收入', direction: 'income' })).id;
    ids.bank = (await resources.create(admin, 'bank-accounts', { kind: 'company_public', accountName: '公户', bank: '测试银行', accountNo: '6222000011112222', balance: 100000 })).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('没发布前不能发起；配置要有人、岗位必须恰好一人；没有配置权限不能改', async () => {
    await expect(flow.start(req, 'license-borrow', borrowPayload())).rejects.toThrow(/还没有启用/);
    // 申请中心要展示流程环节：只给步骤名称和类型，不带办理人
    const tpls = await flow.templates(req);
    const borrow = tpls.find((t: { key: string }) => t.key === 'license-borrow')!;
    expect(borrow.steps.map((x: { name: string }) => x.name)).toEqual(['提交申请', '审批', '交接执照', '确认归还', '结束']);
    expect(JSON.stringify(borrow.steps)).not.toContain('assignee');
    await expect(flow.saveDraft(req, 'license-borrow', [], [])).rejects.toThrow(/权限/);
    await expect(flow.saveDraft(admin, 'license-borrow', [
      step('apply', '提交申请', 'submit', undefined, { assignee: { source: 'requester' } }), step('approve', '审批', 'approval'), step('handover', '交接执照', 'execute', keeper.id), step('receive_back', '确认归还', 'execute', keeper.id), step('end', '结束', 'end'),
    ], [])).rejects.toThrow(/办理人/);
    // 岗位没人 → 发布失败
    const pos = await ds.query('INSERT INTO positions (company_id, name, workspace_type) VALUES (?, ?, ?)', [admin.companyId, '空岗位', 'operations']);
    await flow.saveDraft(admin, 'license-borrow', [
      step('apply', '提交申请', 'submit', undefined, { assignee: { source: 'requester' } }), { key: 'approve', name: '审批', type: 'approval', assignee: { source: 'position', id: pos.insertId } },
      step('handover', '交接执照', 'execute', keeper.id), step('receive_back', '确认归还', 'execute', keeper.id), step('end', '结束', 'end'),
    ], []);
    await expect(flow.publish(admin, 'license-borrow')).rejects.toThrow(/恰好 1 名/);
  });

  it('借用执照：审批→交接（自动登记借用记录）→确认归还（自动改已归还）；待办、抄送、通知都对', async () => {
    await publishBorrow();
    await expect(flow.start(stranger, 'license-borrow', borrowPayload())).resolves.toBeDefined(); // 路人也能申请（有发起权限）
    // 同一执照同一物品已有在办的申请 → 不能重复
    await expect(flow.start(req, 'license-borrow', borrowPayload())).rejects.toThrow(/已经有/);
    const lic2 = (await resources.create(admin, 'licenses', { category: 'operation', companyName: '乙', creditCode: `FLOW-${key()}`, legalPerson: '李' })).id;
    await expect(flow.start(req, 'license-borrow', borrowPayload({ licenseId: lic2, purpose: '' }))).rejects.toThrow(/用途/);
    const run = await flow.start(req, 'license-borrow', borrowPayload({ licenseId: lic2 }), key());
    expect(run.status).toBe('running');
    expect(run.activeStep?.key).toBe('approve');
    expect(run.activeStep?.recipients.map((r) => r.name)).toEqual(['审批人']);
    expect(run.me.canPass).toBe(false);

    // 幂等：同 requestKey 不重复建
    const rk = key();
    const lic3 = (await resources.create(admin, 'licenses', { category: 'operation', companyName: '丙', creditCode: `FLOW-${key()}`, legalPerson: '赵' })).id;
    const a1 = await flow.start(req, 'license-borrow', borrowPayload({ licenseId: lic3 }), rk);
    const a2 = await flow.start(req, 'license-borrow', borrowPayload({ licenseId: lic3 }), rk);
    expect(a2.id).toBe(a1.id);

    // 非办理人不能办；管理员也不是自动办理人
    await expect(flow.pass(keeper, run.id, { revision: run.revision, stepId: run.activeStep!.id })).rejects.toThrow(/不是你办理/);
    await expect(flow.pass(admin, run.id, { revision: run.revision, stepId: run.activeStep!.id })).rejects.toThrow(/不是你办理/);
    const todo = await flow.todos(boss1, { tab: 'pending', page: 1, pageSize: 20 });
    expect(todo.rows.some((r: { runId: number }) => r.runId === run.id)).toBe(true);
    // 待办按关键字搜索（标题）：搜得到自己的，搜不存在的词为空；通配符按字面处理
    const hit = await flow.todos(boss1, { tab: 'pending', keyword: run.title.slice(0, 3), page: 1, pageSize: 20 });
    expect(hit.rows.some((r: { runId: number }) => r.runId === run.id)).toBe(true);
    expect((await flow.todos(boss1, { tab: 'pending', keyword: '不存在的词语xyz', page: 1, pageSize: 20 })).total).toBe(0);
    expect((await flow.todos(boss1, { tab: 'pending', keyword: '%', page: 1, pageSize: 20 })).total).toBe(0);
    // 版本号过期
    await expect(flow.pass(boss1, run.id, { revision: run.revision - 1, stepId: run.activeStep!.id })).rejects.toThrow(/刷新/);

    const afterApprove = await flow.pass(boss1, run.id, { revision: run.revision, stepId: run.activeStep!.id, comment: '同意' });
    expect(afterApprove.activeStep?.key).toBe('handover');
    expect(afterApprove.ccs.map((c) => c.name)).toEqual(['路人']);
    expect((await flow.notifications(stranger, true)).items.some((n) => n.kind === 'cc')).toBe(true);
    // 已经办过的审批人不能再办
    await expect(flow.pass(boss1, run.id, { revision: afterApprove.revision, stepId: afterApprove.activeStep!.id })).rejects.toThrow(/不是你办理/);

    // 交接后：借用记录自动生成；审批之后不能撤回
    await expect(flow.withdraw(req, run.id, { revision: afterApprove.revision })).rejects.toThrow(/已经有人办理/);
    const handed = await flow.pass(keeper, run.id, { revision: afterApprove.revision, stepId: afterApprove.activeStep!.id, form: { note: '放保险柜' } });
    expect(handed.activeStep?.key).toBe('receive_back');
    expect(handed.links.borrowRecordId).toBeGreaterThan(0);
    const rec = await resources.get(admin, 'license-borrows', handed.links.borrowRecordId!);
    expect(rec.status).toBe('borrowed');
    // 交接之后：取消被拦、退回被拦
    expect(handed.me.canCancel).toBe(false);
    await expect(flow.stop(keeper, run.id, 'cancel', { revision: handed.revision, stepId: handed.activeStep!.id, reason: '算了' })).rejects.toThrow(/已经登记借出/);
    await expect(flow.returnBack(keeper, run.id, { revision: handed.revision, stepId: handed.activeStep!.id, reason: '退' })).rejects.toThrow();
    // 归还要填归还日期
    await expect(flow.pass(keeper, run.id, { revision: handed.revision, stepId: handed.activeStep!.id, form: {} })).rejects.toThrow(/实际归还/);
    const done = await flow.pass(keeper, run.id, { revision: handed.revision, stepId: handed.activeStep!.id, form: { returnedAt: '2026-03-15' } });
    expect(done.status).toBe('completed');
    const rec2 = await resources.get(admin, 'license-borrows', handed.links.borrowRecordId!);
    expect(rec2.status).toBe('returned');
    expect((await flow.notifications(req, false)).items.some((n) => n.kind === 'result')).toBe(true);
    // 完成的流程待办清零
    expect(await ds.manager.count(WorkItem, { where: { runId: run.id, status: 'open' } })).toBe(0);
  });

  it('退回给发起人 → 修改后重新提交；发起人可撤回；拒绝要写原因', async () => {
    const lic = (await resources.create(admin, 'licenses', { category: 'operation', companyName: '退回公司', creditCode: `FLOW-${key()}`, legalPerson: '孙' })).id;
    const run = await flow.start(req, 'license-borrow', borrowPayload({ licenseId: lic }));
    await expect(flow.returnBack(boss1, run.id, { revision: run.revision, stepId: run.activeStep!.id, reason: '' })).rejects.toThrow(/原因/);
    const back = await flow.returnBack(boss1, run.id, { revision: run.revision, stepId: run.activeStep!.id, reason: '用途写具体点' });
    expect(back.activeStep?.type).toBe('submit');
    expect((await refresh(req, run.id)).me.canResubmit).toBe(true);
    await expect(flow.resubmit(boss1, run.id, { revision: back.revision, payload: borrowPayload({ licenseId: lic }) })).rejects.toThrow(/发起人/);
    const again = await flow.resubmit(req, run.id, { revision: back.revision, payload: borrowPayload({ licenseId: lic, purpose: '新店开通要执照原件' }) });
    expect(again.activeStep?.key).toBe('approve');
    expect(again.payload.purpose).toBe('新店开通要执照原件');
    const withdrawn = await flow.withdraw(req, run.id, { revision: again.revision, reason: '不借了' });
    expect(withdrawn.status).toBe('cancelled');
    expect(await ds.manager.count(WorkItem, { where: { runId: run.id, status: 'open' } })).toBe(0);
    // 终止后再办理被拒
    await expect(flow.pass(boss1, run.id, { revision: withdrawn.revision, stepId: again.activeStep!.id })).rejects.toThrow(/结束/);
    // 拒绝
    const r2 = await flow.start(req, 'license-borrow', borrowPayload({ licenseId: lic }));
    const rejected = await flow.stop(boss1, r2.id, 'reject', { revision: r2.revision, stepId: r2.activeStep!.id, reason: '不合规' });
    expect(rejected.status).toBe('rejected');
  });

  it('只有管理员能转交，转交后新办理人才能办；看不到别人的流程', async () => {
    const lic = (await resources.create(admin, 'licenses', { category: 'operation', companyName: '转交公司', creditCode: `FLOW-${key()}`, legalPerson: '周' })).id;
    const run = await flow.start(req, 'license-borrow', borrowPayload({ licenseId: lic }));
    await expect(flow.transfer(boss1, run.id, { revision: run.revision, toUserId: fin.id, reason: 'x' })).rejects.toThrow(/管理员/);
    const moved = await flow.transfer(admin, run.id, { revision: run.revision, toUserId: fin.id, reason: '审批人出差' });
    expect(moved.activeStep?.recipients.map((r) => r.name)).toEqual(['出纳']);
    await expect(flow.pass(boss1, run.id, { revision: moved.revision, stepId: moved.activeStep!.id })).rejects.toThrow(/不是你办理/);
    await flow.pass(fin, run.id, { revision: moved.revision, stepId: moved.activeStep!.id });
    // 不相关的人看不了详情；总览权限可以
    await expect(flow.detail(au(await mkUser(admin.companyId, `x${key().slice(0, 6)}`, '外人'), admin.companyId, '外人'), run.id)).rejects.toThrow(/权限/);
    const viewer = au(boss1.id, admin.companyId, '总览', ['flow.overview.view']);
    await expect(flow.listRuns(boss1, { view: 'all', page: 1, pageSize: 10 })).rejects.toThrow(/权限/);
    expect((await flow.listRuns(viewer, { view: 'all', page: 1, pageSize: 50 })).total).toBeGreaterThan(3);
    expect((await flow.listRuns(req, { view: 'started', page: 1, pageSize: 50 })).rows.every((r: { requesterId: number }) => r.requesterId === req.id)).toBe(true);
    expect((await flow.listRuns(stranger, { view: 'cc', page: 1, pageSize: 50 })).total).toBeGreaterThan(0);
  });

  it('逾期扫描：通知办理人和升级对象，只通知一次', async () => {
    const lic = (await resources.create(admin, 'licenses', { category: 'operation', companyName: '逾期公司', creditCode: `FLOW-${key()}`, legalPerson: '吴' })).id;
    const run = await flow.start(req, 'license-borrow', borrowPayload({ licenseId: lic }));
    const before = await ds.manager.count(Notification, { where: { userId: boss1.id, kind: 'overdue' } });
    await flow.scanOverdue(new Date(Date.now() + 10 * 60_000)); // 先清掉之前用例里已经按日期逾期的待办
    const mine = await ds.manager.findOneOrFail(WorkItem, { where: { runId: run.id, status: 'open' } });
    expect(mine.overdueNotifiedAt).toBeNull(); // 这张刚发起，还没到 60 分钟
    const n = await flow.scanOverdue(new Date(Date.now() + 3 * 3600_000));
    expect(n).toBeGreaterThan(0);
    expect(await ds.manager.count(Notification, { where: { userId: boss1.id, kind: 'overdue' } })).toBeGreaterThan(before);
    expect((await flow.todos(boss1, { tab: 'overdue', page: 1, pageSize: 50 })).rows.length).toBeGreaterThan(-1);
    expect(await flow.scanOverdue(new Date(Date.now() + 3 * 3600_000))).toBe(0);
    expect(run.id).toBeGreaterThan(0);
  });

  it('费用申请：付款步骤自动生成并过账费用单，银行余额同步；费用单不能被流程之外随意重复', async () => {
    await flow.saveDraft(admin, 'expense-request', [
      step('apply', '提交申请', 'submit', undefined, { assignee: { source: 'requester' } }), step('approve', '审批', 'approval', boss1.id),
      step('pay', '财务付款', 'finance', fin.id), step('end', '结束', 'end'),
    ], []);
    await flow.publish(admin, 'expense-request');
    await expect(flow.start(req, 'expense-request', { feeItemId: ids.feeIn, amountCents: 5000, occurredAt: day, reason: '收入项目' })).rejects.toThrow(/支出/);
    const run = await flow.start(req, 'expense-request', { feeItemId: ids.feeOut, amountCents: 8800, occurredAt: day, payee: '房东', reason: '三月房租' });
    const ap = await flow.pass(boss1, run.id, { revision: run.revision, stepId: run.activeStep!.id });
    expect(ap.activeStep?.key).toBe('pay');
    await expect(flow.pass(fin, run.id, { revision: ap.revision, stepId: ap.activeStep!.id, form: { paidAt: day } })).rejects.toThrow(/付款账户/);
    const before = (await docs.bankBalances(admin)).find((b: { id: number }) => b.id === ids.bank) as { balanceCents: number };
    const done = await flow.pass(fin, run.id, { revision: ap.revision, stepId: ap.activeStep!.id, form: { bankAccountId: ids.bank, paidAt: day } });
    expect(done.status).toBe('completed');
    expect(done.links.docId).toBeGreaterThan(0);
    const doc = await docs.get(admin, done.links.docId!);
    expect(doc.status).toBe('posted');
    expect(doc.amountCents).toBe(8800);
    const after = (await docs.bankBalances(admin)).find((b: { id: number }) => b.id === ids.bank) as { balanceCents: number };
    expect(before.balanceCents - after.balanceCents).toBe(8800);
  });

  it('自动记账来自模板声明：付款凭证号当银行流水号，同一个凭证号不能在第二条流程里再记一笔；失败时流程停在原步骤', async () => {
    const mkRun = async () => {
      const run = await flow.start(req, 'expense-request', { feeItemId: ids.feeOut, amountCents: 1200, occurredAt: day, reason: '凭证防重复' });
      return flow.pass(boss1, run.id, { revision: run.revision, stepId: run.activeStep!.id });
    };
    const a = await mkRun();
    const doneA = await flow.pass(fin, a.id, { revision: a.revision, stepId: a.activeStep!.id, form: { bankAccountId: ids.bank, paidAt: day, voucher: 'TXN-20260310-01' } });
    expect(doneA.status).toBe('completed');
    const docA = await docs.get(admin, doneA.links.docId!);
    expect(docA.refNo).toBe('TXN-20260310-01');
    const [{ sk }] = await ds.query('SELECT source_key AS sk FROM finance_documents WHERE id = ?', [docA.id]);
    expect(sk).toBe(`flow:${a.id}:pay`);
    const b = await mkRun();
    const bal = async () => ((await docs.bankBalances(admin)).find((x: { id: number }) => x.id === ids.bank) as { balanceCents: number }).balanceCents;
    const before = await bal();
    await expect(flow.pass(fin, b.id, { revision: b.revision, stepId: b.activeStep!.id, form: { bankAccountId: ids.bank, paidAt: day, voucher: 'TXN-20260310-01' } })).rejects.toThrow(/已经登记过/);
    expect(await bal()).toBe(before); // 整体回滚
    expect((await flow.detail(fin, b.id)).activeStep?.key).toBe('pay');
    const okB = await flow.pass(fin, b.id, { revision: b.revision, stepId: b.activeStep!.id, form: { bankAccountId: ids.bank, paidAt: day, voucher: 'TXN-20260310-02' } });
    expect(okB.status).toBe('completed');
  });

  it('模板可以声明“整条流程完成时”记账：不再依赖某个具体步骤', async () => {
    const base = FLOW_TEMPLATES.find((t) => t.key === 'expense-request')!;
    const tpl = {
      key: 'complete-expense', label: '完成即记账（测试）', description: '测试', fields: [...base.fields, { key: 'paidOn', label: '付款日期', group: '费用', type: 'date', required: true }, { key: 'payBank', label: '付款账户', group: '费用', type: 'ref', ref: 'bank-accounts', required: true }],
      stepFields: {}, steps: [{ key: 'apply', name: '提交', type: 'submit', assignee: { source: 'requester' }, locked: true }, { key: 'approve', name: '审批', type: 'approval', locked: true }, { key: 'end', name: '结束', type: 'end', locked: true }],
      posting: { at: 'complete', docType: 'expense', post: false, date: 'payload.paidOn', bankAccountId: 'payload.payBank', feeItemId: 'payload.feeItemId', amountCents: 'payload.amountCents', memo: 'payload.reason' },
    } as unknown as FlowTemplate;
    expect(validatePostingDecl(tpl)).toEqual([]);
    (FLOW_TEMPLATES as FlowTemplate[]).push(tpl);
    FLOW_ADAPTERS[tpl.key] = { key: tpl.key, title: async () => '完成即记账' };
    try {
      await flow.saveDraft(admin, tpl.key, [step('apply', '提交', 'submit', undefined, { assignee: { source: 'requester' } }), step('approve', '审批', 'approval', boss1.id), step('end', '结束', 'end')], []);
      await flow.publish(admin, tpl.key);
      const run = await flow.start(req, tpl.key, { feeItemId: ids.feeOut, amountCents: 3300, occurredAt: day, reason: '完成即记账', paidOn: day, payBank: ids.bank });
      const done = await flow.pass(boss1, run.id, { revision: run.revision, stepId: run.activeStep!.id });
      expect(done.status).toBe('completed');
      const doc = await docs.get(admin, done.links.docId!);
      expect(doc).toMatchObject({ docType: 'expense', status: 'draft', amountCents: 3300 }); // post:false → 停在草稿
    } finally {
      (FLOW_TEMPLATES as FlowTemplate[]).pop();
      delete FLOW_ADAPTERS['complete-expense'];
    }
  });
});
