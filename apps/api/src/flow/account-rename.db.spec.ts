/** 账号名称改名流程（真实数据库）。RESOURCE_DB_TEST=1 TEST_DB_NAME=xxx npx jest account-rename */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import type { StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Department, User } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { FlowService } from './flow.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('账号名称改名流程', () => {
  let ds: DataSource, flow: FlowService, resources: ReturnType<typeof buildServices>['resources'];
  let admin: AuthUser, applicant: AuthUser, liu: AuthUser, hr1: AuthUser, hr2: AuthUser, outsider: AuthUser;
  let accountId: number, otherId: number;
  const mk = async (companyId: number, account: string, name: string, extra: Partial<User> = {}) =>
    (await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra }))).id;
  const au = (id: number, companyId: number, name: string): AuthUser => ({ id, companyId, name, permissions: { isCompanyAdmin: false, allow: ['flow.apply.view'], deny: [] } });
  const step = (key: string, name: string, type: StepDef['type'], assignee?: StepDef['assignee']): StepDef => ({ key, name, type, ...(assignee ? { assignee } : {}) }) as StepDef;
  const pass = async (u: AuthUser, runId: number, form?: Record<string, unknown>) => {
    const run = await flow.detail(admin, runId);
    return flow.pass(u, runId, { revision: run.revision, stepId: run.activeStep!.id, ...(form ? { form } : {}) });
  };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    resources = buildServices(ds).resources;
    flow = new FlowService(ds, resources, new FinanceDocumentsService(ds));
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `r${crypto.randomBytes(5).toString('hex')}`, name: '改名测试', status: 'active' }));
    const hrDept = await ds.manager.save(Department, ds.manager.create(Department, { companyId: c.id, name: '人事部', status: 'active', sortOrder: 0 }));
    admin = { id: await mk(c.id, 'admin', '管理员', { isCompanyAdmin: true }), companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    applicant = au(await mk(c.id, 'app', '运营小王'), c.id, '运营小王');
    liu = au(await mk(c.id, 'liu', '刘振先'), c.id, '刘振先');
    hr1 = au(await mk(c.id, 'hr1', '人事甲', { departmentId: hrDept.id }), c.id, '人事甲');
    hr2 = au(await mk(c.id, 'hr2', '人事乙', { departmentId: hrDept.id }), c.id, '人事乙');
    outsider = au(await mk(c.id, 'out', '路人'), c.id, '路人');
    accountId = (await resources.create(admin, 'self-media', { platform: 'douyin', name: '旧名字' })).id;
    otherId = (await resources.create(admin, 'self-media', { platform: 'douyin', name: '已占用名' })).id;
    await flow.saveDraft(admin, 'account-rename', [
      step('apply', '提交申请', 'submit', { source: 'requester' }), step('approve_boss', '刘振先审批', 'approval', { source: 'employee', id: liu.id }),
      step('approve_hr', '人事部门审批', 'approval', { source: 'department', id: hrDept.id }), step('rename', '申请人改名并上传截图', 'execute', { source: 'requester' }),
      step('hr_confirm', '人事部通过并自动改名', 'approval', { source: 'department', id: hrDept.id }), step('end', '结束', 'end'),
    ], [liu.id]);
    await flow.publish(admin, 'account-rename');
  });
  afterAll(async () => { await ds?.destroy(); });

  const nameOf = async (id: number) => (await resources.get(admin, 'self-media', id)).title;

  it('发起校验：同名、重名占用、停用账号、重复在办都拒绝', async () => {
    await expect(flow.start(applicant, 'account-rename', { accountId, newName: '旧名字', reason: '换名' })).rejects.toThrow('一样');
    await expect(flow.start(applicant, 'account-rename', { accountId, newName: '已占用名', reason: '换名' })).rejects.toThrow('已经有叫');
    await expect(flow.start(applicant, 'account-rename', { accountId: 999999, newName: '新', reason: '换名' })).rejects.toThrow();
  });

  it('六个节点走完：刘振先→人事部门→申请人传截图→人事部通过时自动改名；日志记流程号', async () => {
    const run = await flow.start(applicant, 'account-rename', { accountId, newName: '新名字', reason: '品牌升级' });
    expect(run.title).toContain('旧名字 → 新名字');
    await expect(flow.start(applicant, 'account-rename', { accountId, newName: '另一个名', reason: '重复' })).rejects.toThrow('在办的改名申请');
    await expect(pass(outsider, run.id)).rejects.toThrow(/不是你办理/);
    await pass(liu, run.id);
    expect(await nameOf(accountId)).toBe('旧名字'); // 审批阶段不改名
    await expect(pass(liu, run.id)).rejects.toThrow(/不是你办理/);
    await pass(hr1, run.id); // 部门里任一人办理
    await expect(pass(hr2, run.id)).rejects.toThrow(/不是你办理/); // 现在轮到申请人
    await expect(pass(applicant, run.id, {})).rejects.toThrow(/截图/);
    await pass(applicant, run.id, { screenshots: [1], note: '已改' });
    expect(await nameOf(accountId)).toBe('旧名字'); // 截图后还没人事确认，不改
    const done = await pass(hr2, run.id);
    expect(done.status).toBe('completed');
    expect(await nameOf(accountId)).toBe('新名字');
    const [log] = await ds.query("SELECT note FROM resource_change_logs WHERE company_id=? AND resource_type='self-media' AND resource_id=? ORDER BY id DESC LIMIT 1", [admin.companyId, accountId]);
    expect(String(log?.note ?? '')).toContain(`流程 #${run.id}`);
  });

  it('人事确认时新名称已被别的账号占用：这一步失败，名称不改', async () => {
    const run = await flow.start(applicant, 'account-rename', { accountId: otherId, newName: '抢注名', reason: '换名' });
    await pass(liu, run.id); await pass(hr1, run.id); await pass(applicant, run.id, { screenshots: [1] });
    await resources.create(admin, 'self-media', { platform: 'douyin', name: '抢注名' });
    await expect(pass(hr1, run.id)).rejects.toThrow('已经有叫');
    expect(await nameOf(otherId)).toBe('已占用名');
  });
});
