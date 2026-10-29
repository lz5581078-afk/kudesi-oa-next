/** 流程配置缺口补齐的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=xxx npx jest --runInBand flow-gaps */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { type StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, FlowDefinition, Notification, User, WorkItem } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { FlowService } from './flow.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('流程缺口补齐（真实数据库）', () => {
  let ds: DataSource;
  let flow: FlowService;
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
  });
});
