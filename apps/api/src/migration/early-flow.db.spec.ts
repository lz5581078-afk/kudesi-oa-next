import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FlowRun, FlowStep, ResourceRecord, User, WorkItem } from '../entities';
import { buildServices } from '../test-support';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import type { AuthUser } from '../common/auth.decorators';
import { runLegacyImport } from './runner';
import type { LegacyArchive } from './protocol';
import { sourceRowHash } from './source-rows';

const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('早期流程在统一引擎续办与旧收支去重（MySQL）', () => {
  let ds: DataSource, svc: ReturnType<typeof buildServices>, flow: FlowService;
  let admin: AuthUser, requester: AuthUser, owner: AuthUser;
  let serial = 4000;
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true }).initialize();
    svc = buildServices(ds); flow = new FlowService(ds, svc.resources, new FinanceDocumentsService(ds));
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: randomBytes(6).toString('hex'), name: '早期流程测试', status: 'active' }));
    const user = async (name: string, isCompanyAdmin = false) => {
      const row = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: randomBytes(6).toString('hex'), name, passwordHash: 'x', status: 'active', isCompanyAdmin, mustChangePassword: false }));
      return { id: row.id, companyId: company.id, name, permissions: { isCompanyAdmin, allow: ['flow.apply.view', 'workbench.todos.view', 'workbench.started.view'], deny: [] } };
    };
    admin = await user('管理员', true); requester = await user('原申请人'); owner = await user('原办理人');
    for (const [old, id] of [[10, requester.id], [20, owner.id]]) await ds.query('INSERT INTO legacy_import_links (source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES (?,?,?,?,?,?,?)', ['legacy-oa', 3, company.id, `user:${old}`, 'user', id, '0'.repeat(64)]);
  });
  afterAll(async () => { await ds?.destroy(); });
  function fixture(options: { existingEntry?: boolean; status?: string; amount?: string; type?: string } = {}) {
    const id = ++serial;
    const row = { id, company_id: 3, type: options.type ?? 'expense', title: `原申请${id}`, status: options.status ?? 'approving', amount: options.amount ?? '12.34', store_id: null, license_id: null, requester_id: 10, current_owner_id: 20, due_at: '2026-10-01 12:00:00', created_at: '2026-09-30 10:00:00', locator: '原始字段不是传输定位令牌' };
    const entry = { id, company_id: 3, workflow_id: id, source_type: 'workflow', direction: 'expense', amount: row.amount, entry_date: '2026-09-29', category: '原费用分类', description: '保留原来不同的说明', created_at: '2026-09-29 10:00:00', store_id: null, license_id: null };
    const archive: LegacyArchive = { company: { id: 3, name: '早期流程测试' }, departments: [], positions: [], employees: [], employeePositions: [], positionPermissions: [], records: [], exclusions: [], loadFile: async () => Buffer.alloc(0), ...(options.existingEntry ? { sourceRows: [{ table: 'finance_entries', key: String(id), row: entry }] } : {}), workflow: { companyId: 3, tables: { workflows: [row], tasks: [{ id, company_id: 3, workflow_id: id, assignee_id: 20, supervisor_id: 10, title: '原独立任务', status: 'pending', source_type: 'workflow', due_at: row.due_at, store_id: null }] } } };
    return { archive, row, entry };
  }
  async function imported(f: ReturnType<typeof fixture>) {
    const opts = { companyId: admin.companyId, actorId: admin.id, expectedName: f.archive.company.name, sourceRowsCrypto: svc.crypto };
    const dry = await runLegacyImport(ds, svc.resources, svc.files, f.archive, { ...opts, apply: false }); expect(dry.failures).toEqual([]);
    expect(await ds.manager.count(FlowRun, { where: { companyId: admin.companyId, title: f.row.title } })).toBe(0);
    const applied = await runLegacyImport(ds, svc.resources, svc.files, f.archive, { ...opts, apply: true, expectedReport: dry }); expect(applied.failures).toEqual([]);
    return { runId: applied.mappings.find(m => m.type === 'early_flow_run')!.targetId, taskId: applied.mappings.find(m => m.type === 'early_work_item')!.targetId };
  }
  it('只恢复原进度，不审批、不记账；原办理人通过后完成，独立旧任务不被误关', async () => {
    const f = fixture(); const before = await ds.manager.count(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-ledger-history' } });
    const ids = await imported(f);
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-ledger-history' } })).toBe(before);
    const detail = await flow.detail(owner, ids.runId);
    expect(detail.status).toBe('running'); expect(detail.me.canPass).toBe(true); expect(detail.me.canReturn).toBe(false);
    expect(detail.dueAt?.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect((await flow.todos(owner, { tab: 'overdue', page: 1, pageSize: 50 })).rows.some((r: { runId: number }) => r.runId === ids.runId)).toBe(true);
    await expect(flow.pass(requester, ids.runId, { revision: detail.revision, stepId: detail.activeStep!.id, form: {} })).rejects.toThrow();
    const complete = await flow.pass(owner, ids.runId, { revision: detail.revision, stepId: detail.activeStep!.id, form: {} });
    expect(complete.status).toBe('completed'); expect(complete.payload.legacyResult).toBe('approved');
    expect((await ds.manager.findOneByOrFail(WorkItem, { id: ids.taskId })).status).toBe('open');
    const own = await flow.detail(admin, ids.runId); expect(own.links.ledgerHistoryId).toBeTruthy();
    expect((await svc.resources.get(admin, 'finance-ledger-history', own.links.ledgerHistoryId!)).data).toMatchObject({ amountCents: 1234, direction: 'expense', description: f.row.title, sourceLabel: '旧流程续办' });
    expect(Number((await ds.query('SELECT COUNT(*) n FROM finance_entries WHERE company_id=?', [admin.companyId]))[0].n)).toBe(0);
    await expect(flow.pass(owner, ids.runId, { revision: complete.revision, stepId: detail.activeStep!.id, form: {} })).rejects.toThrow();
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-ledger-history' } })).toBe(before + 1);
  });
  it('已有同额旧收支时复用原记录，保留旧日期说明；不会再次生成费用或银行流水', async () => {
    const f = fixture({ existingEntry: true }); const ids = await imported(f);
    const before = await ds.manager.count(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-ledger-history' } });
    const detail = await flow.detail(owner, ids.runId);
    await flow.pass(owner, ids.runId, { revision: detail.revision, stepId: detail.activeStep!.id, form: {} });
    const result = await flow.detail(admin, ids.runId);
    expect((await svc.resources.get(admin, 'finance-ledger-history', result.links.ledgerHistoryId!)).data).toMatchObject({ entryDate: f.entry.entry_date, description: f.entry.description, amountCents: 1234 });
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-ledger-history' } })).toBe(before);
  });
  it('原始证据被破坏时整次办理回滚，不能先标完成后记账失败', async () => {
    const f = fixture(); const ids = await imported(f); const detail = await flow.detail(owner, ids.runId);
    await ds.query('UPDATE legacy_source_rows SET source_hash=? WHERE company_id=? AND source_table=? AND source_key=?', ['0'.repeat(64), admin.companyId, 'workflows', String(f.row.id)]);
    try {
      await expect(flow.pass(owner, ids.runId, { revision: detail.revision, stepId: detail.activeStep!.id, form: {} })).rejects.toThrow('完整性');
      expect((await ds.manager.findOneByOrFail(FlowRun, { id: ids.runId })).status).toBe('running');
      expect((await ds.manager.findOneByOrFail(FlowStep, { id: detail.activeStep!.id })).status).toBe('active');
    } finally { await ds.query('UPDATE legacy_source_rows SET source_hash=? WHERE company_id=? AND source_table=? AND source_key=?', [sourceRowHash(f.row), admin.companyId, 'workflows', String(f.row.id)]); }
  });
});
