import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FlowRun, FlowStep, ResourceRecord, User, UserPermissionOverride, WorkItem } from '../entities';
import { buildServices } from '../test-support';
import { FlowService } from '../flow/flow.service';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { OutboxService } from '../outbox/outbox.service';
import { prepareSkuContinuation } from './sku-continuation';
import { importSkuContinuation } from './sku-continuation-import';
import { readSourceRow } from './source-rows';
import type { AuthUser } from '../common/auth.decorators';
import { runLegacyImport } from './runner';
import type { LegacyArchive } from './protocol';
import { importStandaloneTask, importEarlyTask } from './task-continuation-import';
import { TaskService } from '../flow/task.service';
import { restoreWorkflowAccess } from './workflow-access';

const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('旧SKU在原运营节点续办（真实数据库）', () => {
  let ds: DataSource, svc: ReturnType<typeof buildServices>, flow: FlowService;
  let admin: AuthUser, ops: AuthUser, wh: AuthUser, fin: AuthUser;
  const targets = new Map<string, number>();
  let scenarioId: number;
  let serial = 1000;
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never).initialize();
    svc = buildServices(ds);
    const outbox = new OutboxService(ds, svc.resources);
    flow = new FlowService(ds, svc.resources, new FinanceDocumentsService(ds), new BundleToolsService(ds, svc.resources, outbox), outbox);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `resume${randomBytes(4).toString('hex')}`, name: '旧流程续办测试', status: 'active' }));
    const user = async (name: string, allow: string[] = [], isCompanyAdmin = false): Promise<AuthUser> => {
      const r = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `${name}${randomBytes(4).toString('hex')}`, name, passwordHash: 'x', status: 'active', isCompanyAdmin, mustChangePassword: false }));
      return { id: r.id, companyId: c.id, name, permissions: { isCompanyAdmin, allow, deny: [] } };
    };
    admin = await user('管理员', [], true); ops = await user('原发起人', ['flow.apply.view']); wh = await user('原仓库');
    fin = await user('原财务', ['product.cost.view', 'resource.finance-bundles.create', 'resource.finance-bundles.edit']);
    for (const [old, target] of [[10, ops.id], [20, wh.id], [30, fin.id]]) targets.set(`user:${old}`, target);
    const cat = await svc.resources.create(admin, 'finance-categories', { archiveType: 'raw', name: '旧原料类', code: 'YL' });
    const product = await svc.resources.create(admin, 'finance-products', { archiveType: 'raw', name: '续办主品', categoryId: cat.id, specQty: 1, specUnit: 'KG', purchaseSpec: '千克', purchasePrice: 1000, freight: 1, handlingFee: 1 });
    const base = await svc.resources.create(admin, 'finance-base-codes', { productId: product.id, code: 'RESUME-MAIN', codeChangeReason: '保留旧编码' });
    await svc.resources.changeStatus(admin, 'finance-base-codes', base.id, 'verified'); targets.set('finance-base-codes:11', base.id);
    const shippingCat = await svc.resources.create(admin, 'finance-categories', { archiveType: 'shipping_material', name: '原发货物料', code: 'FH' });
    const shipping = await svc.resources.create(admin, 'finance-products', { archiveType: 'shipping_material', name: '原缓冲物料', categoryId: shippingCat.id, specQty: 1, specUnit: 'PCS', purchaseSpec: '个', weightManual: true, weightG: 1, purchasePrice: 10, freight: 1, handlingFee: 1 });
    const shippingBase = await svc.resources.create(admin, 'finance-base-codes', { productId: shipping.id, code: 'RESUME-OTHER', codeChangeReason: '保留旧编码' });
    await svc.resources.changeStatus(admin, 'finance-base-codes', shippingBase.id, 'verified'); targets.set('finance-base-codes:12', shippingBase.id);
    const bcat = await svc.resources.create(admin, 'finance-categories', { archiveType: 'bundle', name: '原组合分类', code: 'ZH' }); targets.set('finance-categories:bundle-dict:92', bcat.id);
    const platform = await svc.resources.create(admin, 'finance-platforms', { code: 'TB', name: '淘宝' }); targets.set('finance-platforms:10', platform.id);
    scenarioId = (await svc.resources.create(admin, 'finance-scenarios', { code: 'standard', name: '标准', segment: '' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });
  function source(status = 'returned', qty = 2) {
    const n = ++serial;
    const nodes = [
      { id: 70, node_key: 'sales', node_name: '原运营填写', node_type: 'submit', form_schema: { nodeTemplate: 'bundle_sales' }, next_node_keys: ['warehouse'] },
      { id: 71, node_key: 'warehouse', node_name: '原仓库完善', node_type: 'execute', form_schema: { nodeTemplate: 'bundle_fulfillment' }, handler_source_type: 'employee', handler_source_id: 20, due_hours: 60, next_node_keys: ['finance'], reject_to_node_key: 'sales' },
      { id: 72, node_key: 'finance', node_name: '原财务审核', node_type: 'finance', form_schema: { nodeTemplate: 'bundle_review' }, handler_source_type: 'employee', handler_source_id: 30, due_hours: 90, next_node_keys: ['end'], reject_to_node_key: 'warehouse' },
      { id: 73, node_key: 'end', node_name: '完成', node_type: 'end', form_schema: { nodeTemplate: 'end' }, next_node_keys: [] },
    ];
    const stamp = '2026-09-30 10:00:00', due = '2026-10-01 12:00:00';
    return { sourceCompanyId: 3,
      batch: { id: n, company_id: 3, template_id: 9, requester_id: 10, title: '原申请名称', created_at: stamp, template_snapshot: nodes, settings_json: { salesScenario: 'standard', productCategoryDictionaryId: 92, platformCodes: [{ platformId: 10 }] } },
      item: { id: n, company_id: 3, batch_id: n, workflow_instance_id: n, revision: 7, status, payload_json: { specName: '原规格', lines: [{ role: 'main', baseCodeId: 11, quantity: qty }] } },
      run: { id: n, company_id: 3, template_id: 9, requester_id: 10, title: '原申请名称', status: 'processing', graph_status: 'batch', current_node_id: 70, active_node_keys: ['sales'], due_at: due, created_at: stamp },
      records: [
        ...(status === 'returned' ? [{ id: n * 10, workflow_instance_id: n, node_key: 'sales', node_name: '原运营填写', status: 'completed', action: 'submit', is_active: 0, owner_id: 10, created_at: stamp, completed_at: stamp }, { id: n * 10 + 1, workflow_instance_id: n, node_key: 'warehouse', node_name: '原仓库完善', status: 'rejected', action: 'return', is_active: 0, owner_id: 20, created_at: stamp, completed_at: stamp, comment: '原退回意见', timing_json: { handledBy: 20 }, form_payload: { payload: { privateCost: 99 } } }] : []),
        { id: n * 10 + 2, workflow_instance_id: n, node_key: 'sales', node_name: '原运营填写', status: 'pending', action: 'pending', is_active: 1, owner_id: 10, created_at: stamp, completed_at: null },
      ], recipients: [],
      lookup: (type: string, old: unknown) => targets.get(`${type}:${old}`), scenario: (code: string) => code === 'standard' ? scenarioId : undefined, brand: () => undefined,
    };
  }
  const tasks = (s: ReturnType<typeof source>) => [{ id: s.run.id, company_id: 3, workflow_instance_id: s.run.id, workflow_node_record_id: s.run.id * 10 + 2, source_type: 'workflow', status: 'overdue', assignee_id: 10, supervisor_id: 30, title: '原退回待办', due_at: s.run.due_at, created_at: s.run.created_at, completion_standard: '修改后继续提交' }];
  const importOne = async (s: ReturnType<typeof source>, oldTasks = tasks(s), rollback = false) => {
    const ids = new Map<string, number>();
    return ds.transaction(async em => {
      em.queryRunner!.data.legacyImport = true;
      const ctx = { em, crypto: svc.crypto, companyId: ops.companyId, lookup: (type: string, old: string) => ids.get(`${type}:${old}`), register: async (type: string, old: string, target: number) => { ids.set(`${type}:${old}`, target); } };
      const result = await importSkuContinuation(ctx, s, oldTasks);
      expect((await importSkuContinuation(ctx, s, oldTasks)).reused).toBe(true);
      if (rollback) throw new Error('rollback resume');
      return result;
    });
  };
  it('原进度、退回意见、原时限与待办保留，不发通知、不生成组合；原人能提交并经仓库财务完成', async () => {
    const s = source();
    s.item.payload_json.lines.push({ role: 'other', baseCodeId: 12, quantity: 2 });
    Object.assign(s.item.payload_json, { notRequired: { package: '原料直发', label: '无需标签', labor: '无需人工' }, warehouseNote: '原仓库配置备注' });
    const notificationCount = async () => Number((await ds.query('SELECT COUNT(*) n FROM notifications WHERE company_id=?', [ops.companyId]))[0].n);
    const before = await notificationCount();
    const imported = await importOne(s);
    expect(await notificationCount()).toBe(before);
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: ops.companyId, type: 'finance-bundles' } })).toBe(0);
    const current = await ds.manager.findOneByOrFail(FlowRun, { id: imported.runId, companyId: ops.companyId });
    expect(current.revision).toBe(7); expect(current.currentStepKey).toBe('apply');
    expect(current.dueAt?.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    const history = await ds.manager.find(FlowStep, { where: { runId: current.id, companyId: ops.companyId }, order: { seq: 'ASC' } });
    expect(history.map(r => r.status)).toEqual(['done', 'returned', 'active']);
    expect(history[1].comment).toBe('原退回意见'); expect(history[1].form).toBeNull();
    expect((await ds.manager.find(WorkItem, { where: { runId: current.id, companyId: ops.companyId, status: 'open' } })).map(r => r.assigneeId)).toEqual([ops.id]);
    const original = await readSourceRow(ds.manager, svc.crypto, { companyId: ops.companyId, sourceCompanyId: 3, table: 'workflow_node_records', key: String(s.run.id * 10 + 1) });
    expect(original?.form_payload).toEqual({ payload: { privateCost: 99 } });
    await expect(flow.resubmit(wh, current.id, { revision: current.revision, payload: current.payload })).rejects.toThrow('发起人');
    const visible = await flow.detail(ops, current.id);
    let run = await flow.resubmit(ops, current.id, { revision: current.revision, payload: visible.payload });
    expect(run.activeStep?.key).toBe('warehouse');
    expect(run.initialForm).toBeUndefined(); // 运营不能取得仓库办理表单
    const whView = await flow.detail(wh, run.id);
    expect(whView.initialForm).toEqual({ config: [{ lines: [{ role: 'other', baseCodeId: targets.get('finance-base-codes:12'), qty: 2 }], notRequired: { package: '原料直发', label: '无需标签', labor: '无需人工' } }], note: '原仓库配置备注' });
    run = await flow.pass(wh, run.id, { revision: run.revision, stepId: run.activeStep!.id, form: whView.initialForm! });
    expect(run.activeStep?.key).toBe('review');
    run = await flow.pass(fin, run.id, { revision: run.revision, stepId: run.activeStep!.id, form: { confirmed: true } });
    expect(run.status).toBe('completed');
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: ops.companyId, type: 'finance-bundles' } })).toBe(1);
    expect(Number((await ds.query('SELECT COUNT(*) n FROM outbox_jobs WHERE company_id=?', [ops.companyId]))[0].n)).toBe(0);
  });
  it('原草稿小数数量不取整、不丢行，也不放宽提交规则或补造待办', async () => {
    const s = source('draft', 0.2); const plan = prepareSkuContinuation(s);
    expect(plan.payload.specs[0].main[0].qty).toBe(0.2); expect(plan.draftValidationErrors.join()).toContain('整数');
    const imported = await importOne(s, []);
    const run = await ds.manager.findOneByOrFail(FlowRun, { id: imported.runId, companyId: ops.companyId });
    expect((run.payload.specs as any[])[0].main[0].qty).toBe(0.2);
    expect(await ds.manager.count(WorkItem, { where: { runId: run.id } })).toBe(0);
    await expect(flow.resubmit(ops, run.id, { revision: run.revision, payload: run.payload })).rejects.toThrow('整数');
  });
  it('事务回滚同时撤销续办与原始证据；公司或当前节点不同直接拒绝', async () => {
    const s = source('draft');
    await expect(importOne(s, [], true)).rejects.toThrow('rollback resume');
    expect(await readSourceRow(ds.manager, svc.crypto, { companyId: ops.companyId, sourceCompanyId: 3, table: 'workflow_instances', key: String(s.run.id) })).toBeNull();
    const altered = source('draft'); altered.run.company_id = 1;
    expect(() => prepareSkuContinuation(altered)).toThrow('公司');
    altered.run.company_id = 3; altered.run.current_node_id = 71;
    expect(() => prepareSkuContinuation(altered)).toThrow('实际进度');
  });
  it('整批空跑列出未兼容早期流程，正式模式拒绝并回滚原始记录，不能只存档后宣布迁完', async () => {
    const archive: LegacyArchive = { company: { id: 3, name: '旧流程续办测试' }, departments: [], positions: [], employees: [], employeePositions: [], positionPermissions: [], records: [], exclusions: [], loadFile: async () => Buffer.alloc(0), workflow: { companyId: 3, tables: { workflows: [{ id: 'early-1', company_id: 3, status: 'processing', type: 'expense' }] } } };
    const opts = { companyId: admin.companyId, actorId: admin.id, expectedName: archive.company.name, sourceRowsCrypto: svc.crypto };
    const result = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: false });
    expect(result.failures).toContainEqual(expect.objectContaining({ type: 'early_flow_run', id: 'early-1', reason: expect.stringContaining('旧早期流程') }));
    await expect(runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: true, expectedReport: result })).rejects.toThrow('禁止正式写入');
    expect(await readSourceRow(ds.manager, svc.crypto, { companyId: admin.companyId, sourceCompanyId: 3, table: 'workflows', key: 'early-1' })).toBeNull();
  });
  it('全量模式不能把零写入错误当成迁完：只存档的历史和未落地余额仍阻止正式提交', async () => {
    const archive: LegacyArchive = { company: { id: 3, name: '旧流程续办测试' }, departments: [{id:99,name:'历史部门',status:'active'}], positions: [], employees: [{id:99,name:'原历史发起人',login_account:null,department_id:99,status:'active'}], employeePositions: [], positionPermissions: [], records: [], exclusions: [{ type: 'bank-accounts.balance', id: 'b1', reason: '旧余额尚未落地' }], loadFile: async () => Buffer.alloc(0), workflow: { companyId: 3, tables: { workflow_instances: [{ id: 'history-only', company_id: 3, requester_id:99,template_id:9,title:'原已完成流程',status: 'completed',created_at:'2026-09-01 09:00:00',completed_at:'2026-09-02 09:00:00' }] } } };
    const opts = { companyId: admin.companyId, actorId: admin.id, expectedName: archive.company.name, sourceRowsCrypto: svc.crypto };
    const dry = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: false });
    expect(dry.failures).toEqual([]); expect(dry.excluded.some(e => e.type === 'workflow-history')).toBe(true);
    const phases: string[] = [];
    await expect(runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: true, expectedReport: dry, prepareReport: report => { phases.push(report.phase); } })).rejects.toThrow('未验收排除项');
    expect(phases).toEqual(['apply-rejected-rollback']);
    expect(await readSourceRow(ds.manager, svc.crypto, { companyId: admin.companyId, sourceCompanyId: 3, table: 'workflow_instances', key: 'history-only' })).toBeNull();
  });
  it('手工任务保留负责人、监督人、原截止时间和完成标准，由原负责人继续提交', async () => {
    const source = { id: 7001, company_id: 3, source_type: 'manual', status: 'overdue', assignee_id: 10, supervisor_id: 30, title: '原手工任务', completion_standard: '保留原完成标准', due_at: '2026-10-01 12:00:00', created_at: '2026-09-30 10:00:00', feedback_schema: [{ key: 'result', label: '处理结果', type: 'text' }, { key: 'note', label: '补充说明', type: 'text' }] };
    const imported = await ds.transaction(async em => {
      em.queryRunner!.data.legacyImport = true;
      const ids = new Map<string, number>();
      const ctx = { em, companyId: admin.companyId, sourceCompanyId: 3, lookup: (type: string, id: unknown) => ids.get(`${type}:${id}`) ?? targets.get(`${type}:${id}`), register: async (type: string, id: string, target: number) => { ids.set(`${type}:${id}`, target); } };
      const r = await importStandaloneTask(ctx, source);
      expect((await importStandaloneTask(ctx, source)).reused).toBe(true);
      await expect(importStandaloneTask(ctx, { ...source, id: 7002, template_id: 1 })).rejects.toThrow('尚未兼容');
      return r;
    });
    const row = await ds.manager.findOneByOrFail(WorkItem, { id: imported.id, companyId: admin.companyId });
    expect(row).toMatchObject({ assigneeId: ops.id, supervisorId: fin.id, completionStandard: '保留原完成标准', status: 'open', routineId: null, feedbackPreset: 'simple' });
    expect(row.dueAt?.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    const service = new TaskService(ds);
    await expect(service.complete(wh, row.id, '代办')).rejects.toThrow('负责人');
    expect((await service.complete(ops, row.id, '完成原任务', { payload: { result: '原任务已办妥', note: '保留原反馈字段' } })).status).toBe('done');
  });
  it('周期待办保留原店铺、负责人、复核人和旧表单默认值，提交后由原监督人复核', async () => {
    const store = await svc.resources.create(admin, 'stores', { name: '旧待办关联店铺', platform: 'pdd' });
    const source = { id: 7101, company_id: 3, source_type: 'routine', template_id: 7, store_id: 5, status: 'overdue', assignee_id: 10, supervisor_id: 30, feedback_to_id: 30, title: '旧周期店铺检查', completion_standard: '检查原店铺售后', feedback_schema: null, due_at: '2026-10-01 12:00:00', created_at: '2026-09-30 10:00:00' };
    const template = { id: 7, company_id: 3, requires_review: 1, frequency: 'daily', submit_schema: { fields: ['未完结数量', '截图', '异常说明'] } };
    const imported = await ds.transaction(async em => {
      em.queryRunner!.data.legacyImport = true;
      const lookup = (type: string, id: unknown) => type === 'stores' && String(id) === '5' ? store.id : targets.get(`${type}:${id}`);
      const ctx = { em, companyId: admin.companyId, sourceCompanyId: 3, lookup, register: async () => {} };
      await expect(importStandaloneTask(ctx, source, { ...template, company_id: 1 })).rejects.toThrow('模板关联');
      await expect(importStandaloneTask({ ...ctx, lookup: (type, id) => type === 'stores' ? targets.get('finance-base-codes:11') : lookup(type, id) }, source, template)).rejects.toThrow('店铺未迁入');
      return importStandaloneTask(ctx, source, template);
    });
    const row = await ds.manager.findOneByOrFail(WorkItem, { id: imported.id, companyId: admin.companyId });
    expect(row).toMatchObject({ storeId: store.id, assigneeId: ops.id, supervisorId: fin.id, requiresReview: true, feedbackPreset: 'simple', routineId: null });
    const todo = (await flow.todos(ops, { tab: 'overdue', page: 1, pageSize: 50 })).rows.find((t: { id: number }) => t.id === row.id);
    expect(todo).toMatchObject({ storeId: store.id, storeName: '旧待办关联店铺' });
    const service = new TaskService(ds);
    const supervised = await service.supervised(fin, { page: 1, pageSize: 50 });
    expect(supervised.rows.find((t: { id: number }) => t.id === row.id)).toMatchObject({ storeId: store.id, storeName: '旧待办关联店铺' });
    expect((await service.complete(ops, row.id, '检查完成', { payload: { result: '原店铺已核对', note: '保留默认通用反馈' } })).status).toBe('reviewing');
    expect((await ds.manager.findOneByOrFail(WorkItem, { id: row.id })).status).toBe('open');
    await expect(service.review(wh, row.id, { action: 'approve' })).rejects.toThrow('监督人');
    await service.review(fin, row.id, { action: 'approve' });
    expect((await ds.manager.findOneByOrFail(WorkItem, { id: row.id })).status).toBe('done');
  });
  it('早期任务与新版同号任务保持独立；原负责人可直接完成，不错误等待复核或联动关闭流程', async () => {
    const source = { id: 1, company_id: 3, workflow_id: 1, assignee_id: 10, supervisor_id: 30, title: '早期待办', status: 'overdue', severity: 'urgent', due_at: '2026-10-01 12:00:00', result_note: null };
    const oldWorkflow = { id: 1, company_id: 3, title: '关联早期流程' };
    const imported = await ds.transaction(async em => {
      em.queryRunner!.data.legacyImport = true;
      const ids = new Map<string, number>();
      const ctx = { em, companyId: admin.companyId, sourceCompanyId: 3, lookup: (type: string, id: unknown) => ids.get(`${type}:${id}`) ?? targets.get(`${type}:${id}`), register: async (type: string, id: string, target: number) => { ids.set(`${type}:${id}`, target); } };
      const modern = await importStandaloneTask(ctx, { id: 1, company_id: 3, source_type: 'manual', assignee_id: 10, title: '新版同号任务', status: 'pending', created_at: '2026-10-01 10:00:00' });
      await expect(importEarlyTask(ctx, source, { ...oldWorkflow, company_id: 1 })).rejects.toThrow('公司不一致');
      const early = await importEarlyTask(ctx, source, oldWorkflow);
      expect(early.id).not.toBe(modern.id); expect((await importEarlyTask(ctx, source, oldWorkflow)).reused).toBe(true);
      return { modern, early };
    });
    const row = await ds.manager.findOneByOrFail(WorkItem, { id: imported.early.id });
    expect(row).toMatchObject({ runId: null, requiresReview: false, feedbackPreset: null, assigneeId: ops.id, supervisorId: fin.id });
    expect(row.description).toContain('关联早期流程'); expect(row.description).toContain('迁入时间'); expect(row.description).toContain('紧急');
    const service = new TaskService(ds);
    expect((await service.complete(ops, row.id, '保留原办理结果')).status).toBe('done');
    expect((await ds.manager.findOneByOrFail(WorkItem, { id: imported.modern.id })).status).toBe('open');
  });
  it('按旧权限证据恢复入口与原财务办理资格，保留明确禁止，不给运营成本或外部写入权限', async () => {
    const evidence = { policyHash: 'a'.repeat(64), employees: [10, 20, 30].map(id => ({ employeeId: String(id), canUseWorkflow: true, canViewCosts: id === 30 })) };
    await ds.manager.insert(UserPermissionOverride, { userId: ops.id, permission: 'flow.apply.view', effect: 'deny' });
    await ds.transaction(async em => {
      em.queryRunner!.data.legacyImport = true;
      const r = await restoreWorkflowAccess(em, { companyId: admin.companyId, sourceCompanyId: 3, actorId: admin.id, source: evidence, lookup: (type, id) => targets.get(`${type}:${id}`) });
      expect(r.denied).toContainEqual({ userId: ops.id, permission: 'flow.apply.view' });
      expect(r.grants.some(g => g.userId === fin.id && g.permission === 'product.cost.view')).toBe(true);
      expect(r.grants.some(g => g.userId === fin.id && g.permission === 'resource.finance-bundles.edit')).toBe(true);
      expect(r.grants.some(g => g.userId === ops.id && g.permission === 'product.cost.view')).toBe(false);
      expect(r.grants.some(g => ['product.cost.edit', 'finance.bundle-sync.manage', '*'].includes(g.permission))).toBe(false);
      await expect(restoreWorkflowAccess(em, { companyId: admin.companyId + 99999, sourceCompanyId: 3, actorId: admin.id, source: evidence, lookup: (type, id) => targets.get(`${type}:${id}`) })).rejects.toThrow('状态不一致');
    });
    expect(await ds.manager.findOneBy(UserPermissionOverride, { userId: ops.id, permission: 'flow.apply.view' })).toMatchObject({ effect: 'deny' });
  });
  it('有加密原始证据才保留旧异常空原因；不伪造原因，普通新增仍拒绝，补充后清除提示', async () => {
    const records = [
      { type: 'stores', id: 'legacy-store', status: 'abnormal', data: { name: '原异常店铺', platform: 'pdd' }, sourceAbnormalRow: { id: 'legacy-store', company_id: 3, name: '原异常店铺', platform: '拼多多', status: 'abnormal', abnormal_reason: null } },
      { type: 'phones', id: 'legacy-phone', status: 'abnormal', data: { number: '13800000000', usageType: 'company_kept' }, sourceAbnormalRow: { id: 'legacy-phone', company_id: 3, number: '13800000000', status: 'abnormal', abnormal_reason: '' } },
    ];
    const archive: LegacyArchive = { company: { id: 3, name: '旧流程续办测试' }, departments: [], positions: [], employees: [], employeePositions: [], positionPermissions: [], records, exclusions: [], loadFile: async () => Buffer.alloc(0) };
    const opts = { companyId: admin.companyId, actorId: admin.id, expectedName: archive.company.name, sourceRowsCrypto: svc.crypto };
    const normal = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: false });
    expect(normal.failures.filter(r => r.reason.includes('异常原因'))).toHaveLength(2);
    const dry = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, preserveLegacyStates: true, apply: false }); expect(dry.failures).toEqual([]);
    const result = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, preserveLegacyStates: true, apply: true, expectedReport: dry }); expect(result.failures).toEqual([]);
    const storeId = result.mappings.find(r => r.type === 'stores')!.targetId;
    const store = await svc.resources.get(admin, 'stores', storeId);
    expect(store.status).toBe('abnormal'); expect(store.data.abnormalReason).toBeFalsy(); expect(store.data.migrationNotice).toContain('未填写原因');
    const original = await readSourceRow(ds.manager, svc.crypto, { companyId: admin.companyId, sourceCompanyId: 3, table: 'stores', key: 'legacy-store' }); expect(original?.abnormal_reason).toBeNull();
    await expect(svc.resources.create(admin, 'stores', { name: '普通异常店铺', platform: 'pdd', migrationNotice: '伪造迁移提示' }, 'abnormal')).rejects.toThrow('异常原因');
    await svc.resources.update(admin, 'stores', storeId, { abnormalReasonText: '真实补充原因' });
    const fixed = await svc.resources.get(admin, 'stores', storeId); expect(fixed.data.abnormalReason).toBeTruthy(); expect(fixed.data.migrationNotice).toBeFalsy();
  });
  it('执照真实分项位置保持同公司；有证据才隔离旧默认总引用并加密原始行', async () => {
    const raw = { id: 'legacy-license', company_id: 3, location_id: 3, original_location_id: 32, duplicate_location_id: 32 };
    const records = [
      { type: 'locations', id: '32', data: { name: '综合柜上层', code: 'REAL-UPPER', scope: 'area' } },
      { type: 'licenses', id: 'legacy-license', data: { category: 'operation', companyName: '测试主体', creditCode: 'LICENSE-RESUME', legalPerson: '测试法人', originalLocationId: { legacyRef: { type: 'locations', id: '32' } }, copyLocationId: { legacyRef: { type: 'locations', id: '32' } } }, sourceLocationOmission: { row: raw, location: { id: 3, company_id: 1, code: 'A-02' } } },
    ];
    const archive: LegacyArchive = { company: { id: 3, name: '旧流程续办测试' }, departments: [], positions: [], employees: [], employeePositions: [], positionPermissions: [], records, exclusions: [], loadFile: async () => Buffer.alloc(0) };
    const opts = { companyId: admin.companyId, actorId: admin.id, expectedName: archive.company.name, preserveLegacyStates: true, sourceRowsCrypto: svc.crypto };
    const dry = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: false }); expect(dry.failures).toEqual([]);
    expect(await readSourceRow(ds.manager, svc.crypto, { companyId: admin.companyId, sourceCompanyId: 3, table: 'business_licenses', key: raw.id })).toBeNull();
    const applied = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: true, expectedReport: dry }); expect(applied.failures).toEqual([]);
    const license = await svc.resources.get(admin, 'licenses', applied.mappings.find(r => r.type === 'licenses')!.targetId);
    expect(license.data.locationId).toBeFalsy();
    expect(license.data.originalLocationId).toBe(applied.mappings.find(r => r.type === 'locations')!.targetId);
    expect(license.data.copyLocationId).toBe(license.data.originalLocationId); expect(license.data.migrationNotice).toContain('默认引用');
    expect(await readSourceRow(ds.manager, svc.crypto, { companyId: admin.companyId, sourceCompanyId: 3, table: 'business_licenses', key: raw.id })).toEqual(raw);
    const invalid = { ...archive, records: [ { ...records[1], id: 'unproven', sourceLocationOmission: { row: { ...raw, id: 'unproven' }, location: { id: 3, company_id: 1, code: 'OTHER' } } } ] };
    const rejected = await runLegacyImport(ds, svc.resources, svc.files, invalid, { ...opts, apply: false });
    expect(rejected.failures.some(r => r.reason.includes('核对证据'))).toBe(true);
  });

  it('旧销售快照落到新经营数据，历史原行与已删除资料原值一同加密保留并可回滚', async () => {
    const raw = { id: 1, company_id: 3, store_id: 8, stat_date: '2026-09-01', sales_amount: '10.00', refund_amount: '1.00', ad_cost: '2.00', platform_fee: '0.30', purchase_cost: '3.00', other_cost: '0.50' };
    const deleted = { id: 9, company_id: 3, code: 'OLD-DELETED-CODE', status: 'deleted', payload_json: '{"kept":"original"}' };
    const archive: LegacyArchive = { company: { id: 3, name: '旧流程续办测试' }, departments: [], positions: [], employees: [], employeePositions: [], positionPermissions: [], records: [
      { type: 'stores', id: 'sales-store', data: { name: '原销售快照店铺', platform: 'pdd' } },
      { type: 'store-daily-metrics', id: 'sales-snapshot:1', data: { storeId: { legacyRef: { type: 'stores', id: 'sales-store' } }, day: raw.stat_date, sales: 1000, refund: 100, adCost: 200, platformFee: 30, purchaseCost: 300, otherCost: 50, source: 'import' } },
    ], sourceRows: [{ table: 'sales_snapshots', key: '1', row: raw }, { table: 'finance_product_base_codes', key: '9', row: deleted }], exclusions: [], loadFile: async () => Buffer.alloc(0) };
    const opts = { companyId: admin.companyId, actorId: admin.id, expectedName: archive.company.name, sourceRowsCrypto: svc.crypto };
    const dry = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: false }); expect(dry.failures).toEqual([]);
    expect(await readSourceRow(ds.manager, svc.crypto, { companyId: admin.companyId, sourceCompanyId: 3, table: 'sales_snapshots', key: '1' })).toBeNull();
    const applied = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: true, expectedReport: dry }); expect(applied.failures).toEqual([]);
    const metric = await svc.resources.get(admin, 'store-daily-metrics', applied.mappings.find(r => r.type === 'store-daily-metrics')!.targetId);
    expect(metric.data).toMatchObject({ sales: 1000, refund: 100, adCost: 200, platformFee: 30, purchaseCost: 300, otherCost: 50, profit: 320, day: '2026-09-01' });
    expect(await readSourceRow(ds.manager, svc.crypto, { companyId: admin.companyId, sourceCompanyId: 3, table: 'sales_snapshots', key: '1' })).toEqual(raw);
    expect(await readSourceRow(ds.manager, svc.crypto, { companyId: admin.companyId, sourceCompanyId: 3, table: 'finance_product_base_codes', key: '9' })).toEqual(deleted);
    const [cipher] = await ds.query('SELECT raw_encrypted AS raw FROM legacy_source_rows WHERE company_id=? AND source_table=? AND source_key=?', [admin.companyId, 'finance_product_base_codes', '9']);
    expect(cipher.raw).not.toContain('OLD-DELETED-CODE');
    await expect(runLegacyImport(ds, svc.resources, svc.files, { ...archive, sourceRows: [{ table: 'stores', key: 'wrong-company', row: { id: 'wrong-company', company_id: 1 } }] }, { ...opts, apply: false })).rejects.toThrow('不属于');
  });

});
