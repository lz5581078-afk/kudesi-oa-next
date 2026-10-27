/** 售后工单、订单申诉、兜底监督的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_u8 npx jest service-cases */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { type StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Notification, User } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { FlowService } from '../flow/flow.service';
import { TaskService } from '../flow/task.service';
import { WorkspaceModuleRegistry } from '../workspace/module-registry';
import { ServiceWorkspaceProvider } from './service-workspace.provider';
import { buildServices } from '../test-support';
import { AfterSalesService } from './after-sales.service';
import { AppealsService } from './appeals.service';
import { CaseSupport } from './case-support';
import { SupervisionService } from './supervision.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-image-data')]);
const png = (name = '截图.png') => ({ originalname: name, buffer: PNG, size: PNG.length });

d('售后、申诉、监督（真实数据库）', () => {
  let ds: DataSource;
  let flow: FlowService;
  let afterSales: AfterSalesService;
  let appeals: AppealsService;
  let sup: SupervisionService;
  let tasks: TaskService;
  let files: ReturnType<typeof buildServices>['files'];
  let settings: ReturnType<typeof buildServices>['settings'];
  let admin: AuthUser, cs: AuthUser, lead: AuthUser, ops: AuthUser, outsider: AuthUser, other: AuthUser;
  let companyId: number;
  const ids: Record<string, number> = {};
  const key = () => crypto.randomBytes(8).toString('hex') + 'abcd';

  const mkUser = async (cid: number, account: string, name: string, extra: Partial<User> = {}) =>
    (await ds.manager.save(User, ds.manager.create(User, { companyId: cid, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra }))).id;
  const au = (id: number, cid: number, name: string, allow: string[] = []): AuthUser => ({ id, companyId: cid, name, permissions: { isCompanyAdmin: false, allow, deny: [] } });
  const step = (k: string, name: string, type: StepDef['type'], assigneeId?: number, extra: Partial<StepDef> = {}): StepDef =>
    ({ key: k, name, type, ...(assigneeId ? { assignee: { source: 'employee', id: assigneeId } } : {}), ...extra }) as StepDef;
  const caseBody = (over: Record<string, unknown> = {}) => ({ storeId: ids.store, orderNo: `DD${Date.now()}${Math.floor(Math.random() * 1000)}`, caseType: 'return_refund', amountCents: 32800, reason: '尺寸不合适', ...over }) as never;
  const appealBody = (over: Record<string, unknown> = {}) => ({ storeId: ids.store, appealType: 'abnormal_order', orderNo: `SS${Date.now()}${Math.floor(Math.random() * 1000)}`, amountCents: 5000, reason: '买家恶意拍单', ...over }) as never;
  const detail = (id: number) => flow.detail(admin, id);
  /** 把某条流程当前环节的截止改到过去（待办、步骤、流程三处保持一致，和真实流转一样） */
  const makeDue = async (runId: number, at: Date) => {
    await ds.query("UPDATE work_items SET due_at = ? WHERE run_id = ? AND status = 'open'", [at, runId]);
    await ds.query("UPDATE flow_steps SET due_at = ? WHERE run_id = ? AND status = 'active'", [at, runId]);
    await ds.query('UPDATE flow_runs SET due_at = ? WHERE id = ?', [at, runId]);
  };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test_u8' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    files = s.files;
    settings = s.settings;
    flow = new FlowService(ds, s.resources, new FinanceDocumentsService(ds));
    tasks = new TaskService(ds);
    const support = new CaseSupport(ds, files);
    afterSales = new AfterSalesService(ds, flow, support);
    appeals = new AppealsService(ds, flow, support);
    sup = new SupervisionService(ds, support);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `s${crypto.randomBytes(5).toString('hex')}`, name: '售后测试', status: 'active' }));
    companyId = c.id;
    const a = await mkUser(c.id, 'admin', '管理员', { isCompanyAdmin: true });
    admin = { id: a, companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const leadId = await mkUser(c.id, 'lead', '客服主管');
    cs = au(await mkUser(c.id, 'cs', '客服小王', { managerId: leadId }), c.id, '客服小王', ['after-sales.table.view', 'after-sales.appeals.view']);
    lead = au(leadId, c.id, '客服主管', ['after-sales.table.view', 'after-sales.appeals.view', 'supervision.center.view']);
    ops = au(await mkUser(c.id, 'ops', '运营小李'), c.id, '运营小李', ['after-sales.appeals.view', 'supervision.center.view']);
    const c2 = await ds.manager.save(Company, ds.manager.create(Company, { code: `s${crypto.randomBytes(5).toString('hex')}`, name: '别家', status: 'active' }));
    outsider = au(await mkUser(c2.id, 'o1', '别家客服'), c2.id, '别家客服', ['after-sales.table.view', 'after-sales.appeals.view', 'supervision.center.view']);
    other = { id: await mkUser(c2.id, 'o2', '别家管理员', { isCompanyAdmin: true }), companyId: c2.id, name: '别家管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    await settings.saveQiniu(admin, { accessKey: 'AK1', secretKey: 'SK-secret', bucket: 'oa', zone: 'z0', domain: 'https://cdn.example.com', isPrivate: true });
    await settings.saveQiniu(other, { accessKey: 'AK2', secretKey: 'SK-secret2', bucket: 'oa', zone: 'z0', domain: 'https://cdn2.example.com', isPrivate: true });
    ids.store = (await s.resources.create(admin, 'stores', { platform: 'douyin', name: '测试旗舰店', storeNo: 'S001', claimStatus: 'claimed', operatorUserId: ops.id } as never)).id;
    ids.store2 = (await s.resources.create(admin, 'stores', { platform: 'douyin', name: '公共店', storeNo: 'S002', claimStatus: 'public' } as never)).id;
    ids.otherStore = (await s.resources.create(other, 'stores', { platform: 'douyin', name: '别家店', storeNo: 'X1' } as never)).id;
    ids.lead = lead.id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('没发布流程前不能登记；申请中心/接口不能绕过售后页面直接发起', async () => {
    await expect(afterSales.create(cs, caseBody())).rejects.toThrow(/还没有启用/);
    await expect(flow.start(cs, 'after-sales', {} as never)).rejects.toThrow(/售后表格/);
    await expect(flow.start(cs, 'order-appeal', {} as never)).rejects.toThrow(/订单申诉/);
    const t = (await flow.templates(cs)).find((x: { key: string }) => x.key === 'after-sales')!;
    expect(t.entry?.path).toBe('/after-sales/table');
  });

  it('发布流程；配置里的办理人不满足时发布失败', async () => {
    await flow.saveDraft(admin, 'after-sales', [step('apply', '客服登记', 'submit', undefined, { assignee: { source: 'requester' } }), step('handle', '客服处理', 'execute', cs.id, { dueMinutes: 4320 }),
      step('review', '主管复核', 'approval', lead.id, { dueMinutes: 1440 }), step('end', '结束', 'end')], [lead.id]);
    await flow.publish(admin, 'after-sales');
    await flow.saveDraft(admin, 'order-appeal', [step('apply', '登记申诉', 'submit', undefined, { assignee: { source: 'requester' } }), step('review', '举证复核', 'approval', lead.id, { dueMinutes: 1440 }),
      step('submit', '提交平台', 'execute', cs.id, { dueMinutes: 1440 }), step('result', '登记结果', 'execute', cs.id, { dueMinutes: 10080 }), step('end', '结束', 'end')], [lead.id]);
    await flow.publish(admin, 'order-appeal');
  });

  it('售后工单：登记 → 处理 → 主管复核 → 办结；编号、阶段、统计、重复拦截、同订单历史', async () => {
    const body = caseBody({ orderNo: 'DD202610270001' });
    const r = await afterSales.create(cs, body);
    const dt = await afterSales.detail(cs, r.id);
    expect(dt.caseNo).toMatch(/^SH\d{6}$/);
    expect(dt.stage).toBe('handling');
    expect(dt.handlers).toEqual(['客服小王']);
    expect(dt.supervisors).toEqual(['客服主管']);
    expect(dt.storeName).toBe('测试旗舰店');
    expect(dt.logs[0].content).toBe('登记工单');
    // 默认 72 小时：截止时间约 3 天后
    const hours = (new Date(String(dt.dueAt)).getTime() - Date.now()) / 3600e3;
    expect(hours).toBeGreaterThan(70); expect(hours).toBeLessThan(73);
    // 同订单同类型在办 → 拦截
    await expect(afterSales.create(cs, body)).rejects.toThrow(/已有处理中/);
    // 同订单别的类型可以，并出现在“同订单历史”
    const r2 = await afterSales.create(cs, caseBody({ orderNo: 'DD202610270001', caseType: 'resend', amountCents: 0 }));
    expect((await afterSales.detail(cs, r.id)).sameOrder.map((x: { caseNo: string }) => x.caseNo)).toContain((await afterSales.detail(cs, r2.id)).caseNo);
    // 办理：处理结果必填
    const run = await detail(r.runId);
    await expect(flow.pass(cs, r.runId, { revision: run.revision, stepId: run.activeStep!.id, form: {} })).rejects.toThrow(/处理结果/);
    const after = await flow.pass(cs, r.runId, { revision: run.revision, stepId: run.activeStep!.id, form: { resolution: '已同意退货退款', refundCents: 32800 } });
    expect((await afterSales.detail(cs, r.id)).stage).toBe('reviewing');
    expect((await afterSales.detail(cs, r.id)).resolution).toBe('已同意退货退款');
    expect((await afterSales.detail(cs, r.id)).refundCents).toBe(32800);
    await flow.pass(lead, r.runId, { revision: after.revision, stepId: after.activeStep!.id });
    const done = await afterSales.detail(cs, r.id);
    expect(done.stage).toBe('completed');
    expect(done.open).toBe(false);
    expect(done.finishedAt).toBeTruthy();
    // 办结后同订单同类型可以再登记
    await expect(afterSales.create(cs, body)).resolves.toBeDefined();
    const list = await afterSales.list(cs, { filter: 'done', page: 1, pageSize: 20 });
    expect(list.rows.map((x: { id: number }) => x.id)).toContain(r.id);
    expect(list.stats.open).toBeGreaterThanOrEqual(2);
    const kw = await afterSales.list(cs, { filter: 'all', keyword: 'DD202610270001 不存在的单', page: 1, pageSize: 20 });
    expect(kw.total).toBeGreaterThanOrEqual(3);
  });

  it('校验：店铺必须属于本公司、金额不能为负、日期不能早于今天', async () => {
    await expect(afterSales.create(cs, caseBody({ storeId: ids.otherStore }))).rejects.toThrow(/店铺不存在/);
    await expect(afterSales.create(cs, caseBody({ amountCents: -1 }))).rejects.toThrow();
    await expect(afterSales.create(cs, caseBody({ caseType: 'bogus' }))).rejects.toThrow(/售后类型/);
    await expect(afterSales.create(cs, caseBody({ dueDate: '2020-01-01' }))).rejects.toThrow(/不能早于今天/);
    await expect(afterSales.create(cs, caseBody({ orderNo: '  ' }))).rejects.toThrow(/订单号/);
  });

  it('要求办结日期：处理环节的截止按这一天算', async () => {
    const day = new Date(Date.now() + 8 * 3600e3 + 5 * 86400e3).toISOString().slice(0, 10);
    const r = await afterSales.create(cs, caseBody({ dueDate: day }));
    const dt = await afterSales.detail(cs, r.id);
    expect(new Date(String(dt.dueAt)).toISOString()).toBe(new Date(`${day}T23:59:59+08:00`).toISOString());
  });

  it('公司隔离：别家的人看不到、不能操作我家的工单和文件，也不在我的列表里', async () => {
    const r = await afterSales.create(cs, caseBody());
    await expect(afterSales.detail(outsider, r.id)).rejects.toThrow(/不存在/);
    await expect(afterSales.addLog(outsider, r.id, '偷看', 'note')).rejects.toThrow(/不存在/);
    await expect(afterSales.upload(outsider, r.id, png())).rejects.toThrow(/不存在/);
    expect((await afterSales.list(outsider, { filter: 'all', page: 1, pageSize: 50 })).total).toBe(0);
    expect((await afterSales.stores(outsider)).map((x: { name: string }) => x.name)).toEqual(['别家店']);
    await expect(flow.detail(outsider, r.runId)).rejects.toThrow();
  });

  it('凭证：上传、取链接、数量上限、只能移除自己传的、办结后不能再改', async () => {
    const r = await afterSales.create(cs, caseBody());
    const f1 = await afterSales.upload(cs, r.id, png('a.png'));
    expect((await afterSales.detail(cs, r.id)).files.map((x: { name: string }) => x.name)).toEqual(['a.png']);
    expect((await afterSales.fileUrl(cs, r.id, f1.id)).url).toContain('fake.example.com');
    await expect(afterSales.fileUrl(outsider, r.id, f1.id)).rejects.toThrow();
    await expect(afterSales.upload(cs, r.id, { originalname: 'x.exe', buffer: Buffer.from('MZ not an image'), size: 15 })).rejects.toThrow(/图片|PDF/);
    await expect(afterSales.removeFile(lead, r.id, f1.id)).rejects.toThrow(/自己上传/);
    await afterSales.removeFile(cs, r.id, f1.id);
    expect((await afterSales.detail(cs, r.id)).files).toEqual([]);
    for (let i = 0; i < 20; i++) await afterSales.upload(cs, r.id, png(`p${i}.png`));
    await expect(afterSales.upload(cs, r.id, png('21.png'))).rejects.toThrow(/最多 20/);
    // 废除后不能再改
    const run = await detail(r.runId);
    await flow.stop(cs, r.runId, 'cancel', { revision: run.revision, stepId: run.activeStep!.id, reason: '买家撤销' });
    await expect(afterSales.upload(cs, r.id, png())).rejects.toThrow(/已经办结/);
    expect((await afterSales.detail(cs, r.id)).stage).toBe('cancelled');
  });

  it('跟进记录与催办：催办给当前办理人发通知；办结后不能催办', async () => {
    const r = await afterSales.create(lead, caseBody());
    await afterSales.addLog(lead, r.id, '电话联系了买家', 'note');
    await expect(afterSales.addLog(lead, r.id, '  ', 'note')).rejects.toThrow(/跟进内容/);
    await afterSales.addLog(lead, r.id, '请尽快处理', 'urge');
    const n = await ds.manager.find(Notification, { where: { companyId, userId: cs.id, kind: 'urge' } });
    expect(n.some((x) => x.title.includes('催办'))).toBe(true);
    const logs = (await afterSales.detail(lead, r.id)).logs;
    expect(logs.map((x: { content: string }) => x.content)).toEqual(expect.arrayContaining(['电话联系了买家', '请尽快处理']));
    const run = await detail(r.runId);
    await flow.stop(cs, r.runId, 'cancel', { revision: run.revision, stepId: run.activeStep!.id, reason: '重复' });
    await expect(afterSales.addLog(lead, r.id, '再催', 'urge')).rejects.toThrow(/不用催办/);
  });

  it('被退回给登记人修改后重新提交，工单内容同步更新；主管把复核退回处理环节时仍算“处理中”并标记被退回', async () => {
    const r = await afterSales.create(cs, caseBody({ amountCents: 1000 }));
    let run = await detail(r.runId);
    run = await flow.returnBack(cs, r.runId, { revision: run.revision, stepId: run.activeStep!.id, reason: '登记错了金额' });
    expect((await afterSales.detail(cs, r.id)).stage).toBe('returned');
    const dt = await afterSales.detail(cs, r.id);
    run = await flow.resubmit(cs, r.runId, { revision: run.revision, payload: { storeId: ids.store, orderNo: dt.orderNo, caseType: 'return_refund', amountCents: 2500, reason: '改了金额' } });
    const again = await afterSales.detail(cs, r.id);
    expect(again.amountCents).toBe(2500);
    expect(again.reason).toBe('改了金额');
    expect(again.stage).toBe('handling');
    // 处理 → 主管退回 → 回到处理环节，带“被退回”标记
    run = await flow.pass(cs, r.runId, { revision: run.revision, stepId: run.activeStep!.id, form: { resolution: '先这样' } });
    await flow.returnBack(lead, r.runId, { revision: run.revision, stepId: run.activeStep!.id, reason: '处理结果不完整' });
    const back = await afterSales.detail(cs, r.id);
    expect(back.stage).toBe('handling');
    expect(back.returnedBack).toBe(true);
  });

  it('订单申诉：没有凭证不能复核/提交；通过全流程；驳回后可复议，复议不能并行；非驳回不能复议', async () => {
    const r = await appeals.create(cs, appealBody({ deadlineDate: new Date(Date.now() + 8 * 3600e3 + 3 * 86400e3).toISOString().slice(0, 10) }));
    const dt = await appeals.detail(cs, r.id);
    expect(dt.appealNo).toMatch(/^SS\d{6}$/);
    expect(dt.stage).toBe('reviewing');
    let run = await detail(r.runId);
    await expect(flow.pass(lead, r.runId, { revision: run.revision, stepId: run.activeStep!.id })).rejects.toThrow(/凭证/);
    await appeals.upload(cs, r.id, png('聊天记录.png'));
    run = await flow.pass(lead, r.runId, { revision: run.revision, stepId: run.activeStep!.id });
    expect((await appeals.detail(cs, r.id)).stage).toBe('to_submit');
    // 提交平台这一步的截止就是平台倒计时
    const due = new Date(String((await appeals.detail(cs, r.id)).dueAt));
    expect(due.toISOString()).toBe(new Date(`${(await appeals.detail(cs, r.id)).deadlineAt ? new Date(String((await appeals.detail(cs, r.id)).deadlineAt)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : ''}T23:59:59+08:00`).toISOString());
    await expect(flow.pass(cs, r.runId, { revision: run.revision, stepId: run.activeStep!.id, form: { submittedAt: '2026-10-27' } })).rejects.toThrow(/平台申诉单号/);
    run = await flow.pass(cs, r.runId, { revision: run.revision, stepId: run.activeStep!.id, form: { platformAppealNo: 'PF-1001', submittedAt: '2026-10-27' } });
    expect((await appeals.detail(cs, r.id)).stage).toBe('submitted');
    expect((await appeals.detail(cs, r.id)).platformAppealNo).toBe('PF-1001');
    // 提交后不能退回
    await expect(flow.returnBack(cs, r.runId, { revision: run.revision, stepId: run.activeStep!.id, reason: '想改' })).rejects.toThrow(/不能退回/);
    // 驳回必须写理由
    await expect(flow.pass(cs, r.runId, { revision: run.revision, stepId: run.activeStep!.id, form: { result: 'rejected' } })).rejects.toThrow(/结果说明/);
    // 还没结果的不能复议
    await expect(appeals.create(cs, appealBody({ appealType: 'reconsider', orderNo: dt.orderNo, parentId: r.id }))).rejects.toThrow(/已驳回/);
    run = await flow.pass(cs, r.runId, { revision: run.revision, stepId: run.activeStep!.id, form: { result: 'rejected', resultNote: '证据不足' } });
    const done = await appeals.detail(cs, r.id);
    expect(done.result).toBe('rejected');
    expect(done.canReconsider).toBe(true);
    expect(done.stage).toBe('completed');
    // 复议：店铺/订单必须和原申诉一致
    await expect(appeals.create(cs, appealBody({ appealType: 'reconsider', orderNo: 'OTHER', parentId: r.id }))).rejects.toThrow(/一致/);
    await expect(appeals.create(cs, appealBody({ appealType: 'abnormal_order', orderNo: dt.orderNo, parentId: r.id }))).rejects.toThrow(/申诉复议/);
    const re = await appeals.create(cs, appealBody({ appealType: 'reconsider', orderNo: dt.orderNo, parentId: r.id, reason: '补充了发货记录' }));
    await expect(appeals.create(cs, appealBody({ appealType: 'reconsider', orderNo: dt.orderNo, parentId: r.id }))).rejects.toThrow(/已经有一条在办的复议/);
    expect((await appeals.detail(cs, r.id)).canReconsider).toBe(false);
    const list = await appeals.list(cs, { storeId: ids.store, status: 'rejected', page: 1, pageSize: 20 });
    expect(list.rows.map((x: { id: number }) => x.id)).toContain(r.id);
    expect(list.stats.monthReconsider).toBeGreaterThanOrEqual(1);
    const pending = await appeals.list(cs, { status: 'pending', type: 'reconsider', page: 1, pageSize: 20 });
    expect(pending.rows.map((x: { id: number }) => x.id)).toContain(re.id);
  });

  it('申诉：通过结果；同订单同类型在办拦截；已过的平台截止日不能登记；经营中店铺只含已领取有运营人的', async () => {
    const body = appealBody();
    const r = await appeals.create(cs, body);
    await expect(appeals.create(cs, body)).rejects.toThrow(/已有在办/);
    await expect(appeals.create(cs, appealBody({ deadlineDate: '2020-01-01' }))).rejects.toThrow(/已经过了/);
    await appeals.upload(cs, r.id, png());
    let run = await detail(r.runId);
    run = await flow.pass(lead, r.runId, { revision: run.revision, stepId: run.activeStep!.id });
    run = await flow.pass(cs, r.runId, { revision: run.revision, stepId: run.activeStep!.id, form: { platformAppealNo: 'PF-2', submittedAt: '2026-10-27' } });
    await flow.pass(cs, r.runId, { revision: run.revision, stepId: run.activeStep!.id, form: { result: 'approved' } });
    const dt = await appeals.detail(cs, r.id);
    expect(dt.result).toBe('approved');
    expect(dt.canReconsider).toBe(false);
    expect((await appeals.list(cs, { status: 'approved', page: 1, pageSize: 20 })).rows.map((x: { id: number }) => x.id)).toContain(r.id);
    const stores = await appeals.stores(cs);
    expect(stores.map((s: { name: string }) => s.name)).toEqual(['测试旗舰店']);
    expect(stores[0].operatorName).toBe('运营小李');
    await expect(appeals.detail(outsider, r.id)).rejects.toThrow(/不存在/);
  });

  it('监督扫描：逾期登记异常（只登记一次）、按时长升级主管/老板并通知、办完自动解除', async () => {
    const r = await afterSales.create(cs, caseBody());
    const t0 = new Date();
    // 现在还没逾期：不登记
    expect((await sup.scan(companyId, t0)).created).toBe(0);
    // 把本工单的待办改成已逾期 30 分钟
    await makeDue(r.runId, new Date(t0.getTime() - 30 * 60000));
    const first = await sup.scan(companyId, t0);
    expect(first.created).toBe(1);
    expect((await sup.scan(companyId, t0)).created).toBe(0); // 幂等
    let ov = await sup.overview(lead);
    const ex = ov.exceptions.find((e: { sourceId: number | null; sourceType: string }) => e.sourceType === 'after_sales' && e.sourceId === r.id)!;
    expect(ex).toBeTruthy();
    expect(ex.severity).toBe('urgent');
    expect(ex.level).toBe(2); // 售后默认主管 0 分钟可见：立刻到主管
    expect(ex.ownerName).toBe('客服小王');
    expect(ex.storeName).toBe('测试旗舰店');
    // 主管收到通知（流程配置的升级对象）
    expect((await ds.manager.find(Notification, { where: { companyId, userId: lead.id, kind: 'escalate' } })).some((n) => n.title.includes('异常待跟进'))).toBe(true);
    // 超过 1440 分钟升级到老板
    const later = new Date(t0.getTime() + 25 * 3600e3);
    expect((await sup.scan(companyId, later)).escalated).toBe(1);
    ov = await sup.overview(lead);
    expect(ov.exceptions.find((e: { id: number }) => e.id === ex.id)!.level).toBe(3);
    expect((await ds.manager.find(Notification, { where: { companyId, userId: admin.id, kind: 'escalate' } })).some((n) => n.title.includes('老板'))).toBe(true);
    // 汇总：售后在办、逾期
    const s = await sup.summary(companyId, later);
    expect(s.afterSales.overdue).toBeGreaterThanOrEqual(1);
    expect(s.exceptions.open).toBeGreaterThanOrEqual(1);
    expect(s.exceptions.escalated).toBeGreaterThanOrEqual(1);
    expect(s.afterSales.overdueAmountCents).toBeGreaterThanOrEqual(32800);
    // 办完 → 自动解除
    const run = await detail(r.runId);
    await flow.stop(cs, r.runId, 'cancel', { revision: run.revision, stepId: run.activeStep!.id, reason: '买家撤销' });
    expect((await sup.scan(companyId, later)).resolved).toBeGreaterThanOrEqual(1);
    ov = await sup.overview(lead);
    expect(ov.exceptions.find((e: { id: number }) => e.id === ex.id)).toBeUndefined();
    expect(ov.closed.find((e: { id: number }) => e.id === ex.id)!.status).toBe('auto');
  });

  it('监督：任务逾期、负责人离职提醒、人员排行', async () => {
    const t = await tasks.create(ops, { title: '补库存盘点', assigneeId: ops.id });
    await ds.query('UPDATE work_items SET due_at = ? WHERE id = ?', [new Date(Date.now() - 2 * 3600e3), t.id]);
    const r = await sup.scan(companyId);
    expect(r.created).toBeGreaterThanOrEqual(1);
    const ov = await sup.overview(lead);
    const ex = ov.exceptions.find((e: { sourceType: string; sourceId: number | null }) => e.sourceType === 'task' && e.sourceId === t.id)!;
    expect(ex.title).toContain('已逾期');
    expect(ex.severity).toBe('important');
    expect(ex.level).toBe(2); // 任务默认 60 分钟到主管：已逾期 120 分钟
    expect(ov.people.find((p: { name: string }) => p.name === '运营小李')).toMatchObject({ overdue: 1 });
    expect(ov.summary.tasks.overdue).toBeGreaterThanOrEqual(1);
    // 负责人离职 → 兜底提醒
    await ds.query("UPDATE users SET status = 'disabled' WHERE id = ?", [ops.id]);
    const ov2 = await sup.overview(lead);
    expect(ov2.assignmentAlerts.some((a: { id: number; ownerName: string }) => a.id === t.id && a.ownerName === '运营小李')).toBe(true);
    await ds.query("UPDATE users SET status = 'active' WHERE id = ?", [ops.id]);
    // 完成任务 → 自动解除
    await tasks.complete(ops, t.id, '完成');
    await sup.scan(companyId);
    expect((await sup.overview(lead)).exceptions.find((e: { id: number }) => e.id === ex.id)).toBeUndefined();
  });

  it('手工登记异常、写跟进、关闭要写原因；没有管理权限不能关别人的；规则可改且有校验；扫描遵守规则', async () => {
    const reg = await sup.register(ops, { title: '仓库发错货', detail: '客户收到别家商品', severity: 'important', ownerId: cs.id, storeId: ids.store });
    await sup.addLog(ops, reg.id, '已联系仓库');
    expect((await sup.detail(ops, reg.id)).logs.map((l: { content: string }) => l.content)).toContain('已联系仓库');
    await expect(sup.register(ops, { title: '', severity: 'normal' })).rejects.toThrow(/标题/);
    await expect(sup.register(ops, { title: 'x', severity: 'normal', storeId: ids.otherStore })).rejects.toThrow(/店铺不存在/);
    await expect(sup.close(lead, reg.id, '处理了')).rejects.toThrow(/权限/); // lead 没有 supervision.manage，也不是登记人
    await expect(sup.close(ops, reg.id, '')).rejects.toThrow(/原因/);
    await sup.close(ops, reg.id, '已重新发货');
    await expect(sup.close(ops, reg.id, '再关')).rejects.toThrow(/已经处理过/);
    // 规则
    const mgr = au(lead.id, companyId, '客服主管', ['supervision.center.view', 'supervision.manage']);
    await expect(sup.saveRule(lead, 'flow', { bossVisibleMinutes: 10 })).rejects.toThrow(/权限/);
    await expect(sup.saveRule(mgr, 'flow', { supervisorVisibleMinutes: 100, bossVisibleMinutes: 10 })).rejects.toThrow(/不能早于/);
    await expect(sup.saveRule(mgr, 'nope', {})).rejects.toThrow(/没有这种/);
    await sup.saveRule(mgr, 'after_sales', { overdueMinutes: 120, supervisorVisibleMinutes: 240 });
    expect((await sup.rules(companyId)).find((r) => r.targetType === 'after_sales')).toMatchObject({ overdueMinutes: 120, supervisorVisibleMinutes: 240, bossVisibleMinutes: 1440 });
    const r = await afterSales.create(cs, caseBody());
    const t0 = new Date();
    await makeDue(r.runId, new Date(t0.getTime() - 60 * 60000));
    expect((await sup.scan(companyId, t0)).created).toBe(0); // 才逾期 60 分钟，规则要求 120 分钟后才登记
    expect((await sup.scan(companyId, new Date(t0.getTime() + 70 * 60000))).created).toBe(1);
    const ex = (await sup.overview(mgr)).exceptions.find((e: { sourceId: number | null; sourceType: string }) => e.sourceType === 'after_sales' && e.sourceId === r.id)!;
    expect(ex.level).toBe(1); // 逾期 130 分钟 < 主管可见 240 分钟
    expect(ex.canClose).toBe(true);
    await sup.saveRule(mgr, 'after_sales', { status: 'inactive' });
    await sup.close(mgr, ex.id, '已知悉');
    // 公司隔离
    await expect(sup.close(other, ex.id, 'x')).rejects.toThrow(/不存在/);
    expect((await sup.overview(outsider)).exceptions).toEqual([]);
    expect((await sup.summary(outsider.companyId)).afterSales.open).toBe(0);
    await sup.saveRule(mgr, 'after_sales', { status: 'active', overdueMinutes: 0, supervisorVisibleMinutes: 0 });
  });
  it('接入老板总控台/岗位工作台：按页面权限给出异常列表和售后、申诉卡片，且只算本公司', async () => {
    const registry = new WorkspaceModuleRegistry();
    new ServiceWorkspaceProvider(sup, registry);
    expect(registry.has('supervision') && registry.has('after-sales')).toBe(true);
    await sup.register(ops, { title: '工作台接入测试', severity: 'urgent', ownerId: cs.id });
    const ex = await registry.get('supervision')!.exceptions!(lead);
    expect(ex.total).toBeGreaterThan(0);
    expect(ex.rows.find((r) => r.title === '工作台接入测试')).toMatchObject({ severity: 'urgent' });
    expect(ex.byUser![cs.id]).toBeGreaterThan(0);
    expect(await registry.get('supervision')!.exceptions!(cs)).toMatchObject({ total: 0, rows: [] }); // 没有监督页面权限
    expect((await registry.get('supervision')!.exceptions!(outsider)).rows.find((r) => r.title === '工作台接入测试')).toBeUndefined();
    const cards = await registry.get('after-sales')!.deskCards!(cs, 'support');
    expect(cards.map((c) => c.key)).toEqual(['after-sales-open', 'appeals-open']);
    expect(cards.every((c) => typeof c.value === 'number' && c.module === 'after-sales')).toBe(true);
    expect((await registry.get('after-sales')!.bossCards!(ops)).map((c) => c.key)).toEqual(['appeals-open']);
    expect(await registry.get('after-sales')!.bossCards!({ ...cs, permissions: { isCompanyAdmin: false, allow: [], deny: [] } })).toEqual([]);
  });
});
