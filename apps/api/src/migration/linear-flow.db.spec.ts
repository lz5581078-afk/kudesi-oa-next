import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FlowRun, ResourceRecord, User, WorkItem } from '../entities';
import { buildServices } from '../test-support';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { TaskService } from '../flow/task.service';
import type { AuthUser } from '../common/auth.decorators';
import { runLegacyImport } from './runner';
import type { LegacyArchive } from './protocol';

const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('旧线性流程原节点、任务独立性和记账边界（MySQL）', () => {
  let ds: DataSource, svc: ReturnType<typeof buildServices>, flow: FlowService;
  let admin: AuthUser, requester: AuthUser, owner: AuthUser, finance: AuthUser, supervisor: AuthUser;
  let serial = 6000;
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true }).initialize();
    svc = buildServices(ds); flow = new FlowService(ds, svc.resources, new FinanceDocumentsService(ds));
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: randomBytes(6).toString('hex'), name: '线性流程测试', status: 'active' }));
    const user = async (name: string, isCompanyAdmin = false): Promise<AuthUser> => {
      const row = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: randomBytes(6).toString('hex'), name, passwordHash: 'x', status: 'active', isCompanyAdmin, mustChangePassword: false }));
      return { id: row.id, companyId: company.id, name, permissions: { isCompanyAdmin, allow: ['flow.apply.view', 'workbench.todos.view', 'workbench.started.view'], deny: [] } };
    };
    admin = await user('管理员', true); requester = await user('申请人'); owner = await user('原负责人'); finance = await user('原财务'); supervisor = await user('原监督人');
    for (const [old, id] of [[10, requester.id], [20, owner.id], [30, finance.id], [40, supervisor.id]]) await ds.query('INSERT INTO legacy_import_links (source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES (?,?,?,?,?,?,?)', ['legacy-oa', 1, company.id, `user:${old}`, 'user', id, '0'.repeat(64)]);
  });
  afterAll(async () => { await ds?.destroy(); });
  function fixture(boundary = false) {
    const id = ++serial;
    const run = { id, company_id: 1, template_id: 1, graph_status: 'linear', title: `线性原申请${id}`, status: boundary ? 'submitted' : 'approving', requester_id: 10, current_owner_id: boundary ? 10 : 20, current_node_id: boundary ? 1 : 2, amount: '30.01', store_id: null, license_id: null, created_at: '2026-06-28 22:26:12', due_at: '2026-06-27 18:00:00', completed_at: null };
    const nodes = ['submit', 'approval', 'finance', 'archive'].map((type, i) => ({ id: i + 1, template_id: 1, node_order: i + 1, node_type: type, node_name: ['原发起', '原审批', '原财务确认', '原归档'][i], creates_task: i === 1 || i === 2 ? 1 : 0, due_hours: i === 3 ? 4 : 12 }));
    const records = [{ id: id * 10, workflow_instance_id: id, template_node_id: 1, node_order: 1, node_name: '原发起', owner_id: 10, status: 'completed', action: 'submitted', comment: '原意见', created_at: run.created_at, completed_at: run.created_at }, ...(!boundary ? [{ id: id * 10 + 1, workflow_instance_id: id, template_node_id: 2, node_order: 2, node_name: '原审批', owner_id: 20, status: 'pending', action: 'pending', comment: null, created_at: run.created_at, completed_at: null }] : [])];
    const task = { id, company_id: 1, workflow_instance_id: id, workflow_node_record_id: id * 10 + 1, source_type: 'workflow', template_id: null, assignee_id: 20, supervisor_id: 40, feedback_to_id: 10, status: 'pending', title: '原独立流程任务', due_at: run.due_at, created_at: run.created_at, feedback_schema: null, store_id: null, completion_standard: '保留原提交要求' };
    const archive: LegacyArchive = { company: { id: 1, name: '线性流程测试' }, departments: [], positions: [], employees: [], employeePositions: [], positionPermissions: [], records: [], exclusions: [], loadFile: async () => Buffer.alloc(0), workflow: { companyId: 1, tables: { workflow_instances: [run], workflow_templates: [{ id: 1, flow_mode: 'graph' }], workflow_template_nodes: nodes, workflow_node_records: records, task_instances: boundary ? [] : [task] }, assignment: { policyHash: 'a'.repeat(64), functions: { resolveAssignee: 'read-only source proof' }, picks: nodes.map(n => ({ runId: String(id), nodeId: String(n.id), owner: { employeeId: n.id >= 3 ? '30' : '20', via: 'role' }, supervisor: { employeeId: '40', via: 'role' } })) }, access: { policyHash: 'b'.repeat(64), employees: [] } } };
    return { archive, id };
  }
  async function imported(f: ReturnType<typeof fixture>) {
    const opts = { companyId: admin.companyId, actorId: admin.id, expectedName: f.archive.company.name, sourceRowsCrypto: svc.crypto };
    const dry = await runLegacyImport(ds, svc.resources, svc.files, f.archive, { ...opts, apply: false }); expect(dry.failures).toEqual([]);
    expect(await ds.manager.count(FlowRun, { where: { companyId: admin.companyId, title: f.archive.workflow!.tables.workflow_instances[0].title } })).toBe(0);
    const applied = await runLegacyImport(ds, svc.resources, svc.files, f.archive, { ...opts, apply: true, expectedReport: dry }); expect(applied.failures).toEqual([]);
    return { runId: applied.mappings.find(m => m.type === 'flow_run')!.targetId, taskId: applied.mappings.find(m => m.type === 'work_item')?.targetId };
  }
  async function pass(user: AuthUser, runId: number) {
    const d = await flow.detail(user, runId);
    return flow.pass(user, runId, { revision: d.revision, stepId: d.activeStep!.id, form: {} }, { quiet: true });
  }
  it('保留当前审批；12是分钟，归档仍需人工办理；原任务不被流程办理误关', async () => {
    const f = fixture(); const ids = await imported(f);
    const d = await flow.detail(owner, ids.runId);
    expect(d.activeStep?.key).toBe('node_2'); expect(d.me.canPass).toBe(true);
    expect(d.dueAt?.toISOString()).toBe('2026-06-27T10:00:00.000Z');
    const before = Date.now(); const next = await pass(owner, ids.runId);
    expect(next.activeStep?.key).toBe('node_3');
    expect(next.dueAt!.getTime() - before).toBeGreaterThanOrEqual(12 * 60000 - 2000);
    expect(next.dueAt!.getTime() - before).toBeLessThan(12 * 60000 + 2000);
    const todo = await ds.manager.findOneByOrFail(WorkItem, { companyId: admin.companyId, runId: ids.runId, status: 'open' });
    expect(todo.assigneeId).toBe(finance.id); expect(todo.supervisorId).toBe(supervisor.id);
    expect((await ds.manager.findOneByOrFail(WorkItem, { id: ids.taskId! })).status).toBe('open');
    const archive = await pass(finance, ids.runId);
    expect(archive.status).toBe('running'); expect(archive.activeStep?.key).toBe('node_4');
    expect((await flow.detail(requester, ids.runId)).me.canPass).toBe(false);
    await expect(pass(requester, ids.runId)).rejects.toThrow('不是你办理');
    expect(await ds.manager.count(WorkItem, { where: { companyId: admin.companyId, runId: ids.runId, status: 'open' } })).toBe(0);
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-ledger-history', uniqueKey: `legacy-flow:${ids.runId}` } })).toBe(0);
    const done = await pass(finance, ids.runId); expect(done.status).toBe('completed');
    const entry = await ds.manager.findOneByOrFail(ResourceRecord, { companyId: admin.companyId, type: 'finance-ledger-history', uniqueKey: `legacy-flow:${ids.runId}` });
    expect(entry.data.amountCents).toBe(3001);
    expect((await ds.manager.findOneByOrFail(WorkItem, { id: ids.taskId! })).status).toBe('open');
    expect(Number((await ds.query('SELECT COUNT(*) n FROM finance_entries WHERE company_id=?', [admin.companyId]))[0].n)).toBe(0);
  });
  it('已提交边界不提前审批、不制造原待办，发起人继续后才进入审批', async () => {
    const ids = await imported(fixture(true));
    const d = await flow.detail(requester, ids.runId); expect(d.activeStep?.key).toBe('continue'); expect(d.me.canPass).toBe(true);
    await expect(pass(owner, ids.runId)).rejects.toThrow();
    expect(await ds.manager.count(WorkItem, { where: { companyId: admin.companyId, runId: ids.runId } })).toBe(0);
    const next = await pass(requester, ids.runId); expect(next.activeStep?.key).toBe('node_2'); expect(next.status).toBe('running');
    expect((await flow.detail(owner, ids.runId)).me.canPass).toBe(true);
  });
  it('缺少选人证明时禁止正式写入，整个批次保持未导入', async () => {
    const f = fixture(); delete f.archive.workflow!.assignment;
    const opts = { companyId: admin.companyId, actorId: admin.id, expectedName: f.archive.company.name, sourceRowsCrypto: svc.crypto };
    const dry = await runLegacyImport(ds, svc.resources, svc.files, f.archive, { ...opts, apply: false });
    expect(dry.failures.some(x => x.type === 'flow_run' && x.reason.includes('选人证据'))).toBe(true);
    await expect(runLegacyImport(ds, svc.resources, svc.files, f.archive, { ...opts, apply: true, expectedReport: dry })).rejects.toThrow();
    expect(await ds.manager.count(FlowRun, { where: { companyId: admin.companyId, title: f.archive.workflow!.tables.workflow_instances[0].title } })).toBe(0);
  });
  it('原流程任务单独提交完成，不推进关联审批', async () => {
    const ids = await imported(fixture());
    const before = await flow.detail(owner, ids.runId);
    await new TaskService(ds).complete(owner, ids.taskId!, '原任务处理完毕', { payload: { note: '按标准完成' } });
    const after = await flow.detail(owner, ids.runId);
    expect(after.activeStep?.key).toBe(before.activeStep?.key); expect(after.revision).toBe(before.revision);
    expect((await ds.manager.findOneByOrFail(WorkItem, { id: ids.taskId! })).status).toBe('done');
  });
});
