/** 店铺改名流程（真实数据库）。RESOURCE_DB_TEST=1 TEST_DB_NAME=xxx npx jest store-rename */
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

d('店铺改名流程', () => {
  let ds: DataSource, flow: FlowService, resources: ReturnType<typeof buildServices>['resources'];
  let admin: AuthUser, applicant: AuthUser, liu: AuthUser, hr1: AuthUser, hr2: AuthUser;
  let storeId: number, linkedId: number;
  const mk = async (companyId: number, account: string, name: string, extra: Partial<User> = {}) =>
    (await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra }))).id;
  const au = (id: number, companyId: number, name: string): AuthUser => ({ id, companyId, name, permissions: { isCompanyAdmin: false, allow: ['flow.apply.view'], deny: [] } });
  const step = (key: string, name: string, type: StepDef['type'], assignee?: StepDef['assignee']): StepDef => ({ key, name, type, ...(assignee ? { assignee } : {}) }) as StepDef;
  const pass = async (u: AuthUser, runId: number, form?: Record<string, unknown>) => {
    const run = await flow.detail(admin, runId);
    return flow.pass(u, runId, { revision: run.revision, stepId: run.activeStep!.id, ...(form ? { form } : {}) });
  };
  const get = async (id: number) => resources.get(admin, 'stores', id);
  const toJst = async (runId: number) => { await pass(liu, runId); await pass(hr1, runId); await pass(applicant, runId, { screenshots: [1] }); };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    resources = buildServices(ds).resources;
    flow = new FlowService(ds, resources, new FinanceDocumentsService(ds));
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `s${crypto.randomBytes(5).toString('hex')}`, name: '店铺改名测试', status: 'active' }));
    const hrDept = await ds.manager.save(Department, ds.manager.create(Department, { companyId: c.id, name: '人事部', status: 'active', sortOrder: 0 }));
    admin = { id: await mk(c.id, 'admin', '管理员', { isCompanyAdmin: true }), companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    applicant = au(await mk(c.id, 'app', '运营小王'), c.id, '运营小王');
    liu = au(await mk(c.id, 'liu', '刘振先'), c.id, '刘振先');
    hr1 = au(await mk(c.id, 'hr1', '人事甲', { departmentId: hrDept.id }), c.id, '人事甲');
    hr2 = au(await mk(c.id, 'hr2', '人事乙', { departmentId: hrDept.id }), c.id, '人事乙');
    storeId = (await resources.create(admin, 'stores', { platform: 'douyin', name: '旧店名' })).id;
    linkedId = (await resources.create(admin, 'stores', { platform: 'douyin', name: '已占用店' })).id;
    await flow.saveDraft(admin, 'store-rename', [
      step('apply', '提交申请', 'submit', { source: 'requester' }), step('approve_boss', '刘振先审批', 'approval', { source: 'employee', id: liu.id }),
      step('approve_hr', '人事部门审批', 'approval', { source: 'department', id: hrDept.id }), step('rename', '申请人平台改名并上传截图', 'execute', { source: 'requester' }),
      step('jst_rename', '人事部聚水潭改名、通过并自动改OA', 'execute', { source: 'department', id: hrDept.id }), step('end', '结束', 'end'),
    ], [liu.id]);
    await flow.publish(admin, 'store-rename');
  });
  afterAll(async () => { await ds?.destroy(); });

  it('发起校验：同名、同平台重名、不存在、停用店铺、重复在办', async () => {
    await expect(flow.start(applicant, 'store-rename', { storeId, newName: '旧店名', reason: 'x' })).rejects.toThrow('一样');
    await expect(flow.start(applicant, 'store-rename', { storeId, newName: '已占用店', reason: 'x' })).rejects.toThrow('已经有叫');
    await expect(flow.start(applicant, 'store-rename', { storeId: 999999, newName: '新', reason: 'x' })).rejects.toThrow();
    const gone = (await resources.create(admin, 'stores', { platform: 'douyin', name: '停用店' })).id;
    await resources.changeStatus(admin, 'stores', gone, 'inactive', '停用');
    await expect(flow.start(applicant, 'store-rename', { storeId: gone, newName: '复活', reason: 'x' })).rejects.toThrow('已停用');
  });

  it('走完：刘振先→人事部门→申请人平台改名→人事部聚水潭改名并通过时自动改OA；记曾用名并同步聚水潭名快照', async () => {
    await ds.query("UPDATE resource_records SET data=JSON_SET(data,'$.jushuitanShopId','JST9','$.jushuitanShopName','旧店名') WHERE id=?", [storeId]);
    const run = await flow.start(applicant, 'store-rename', { storeId, newName: '新店名', reason: '品牌调整' });
    expect(run.title).toContain('旧店名 → 新店名');
    await expect(flow.start(applicant, 'store-rename', { storeId, newName: '别的名', reason: 'x' })).rejects.toThrow('在办的改名申请');
    await pass(liu, run.id);
    await pass(hr1, run.id);
    await expect(pass(applicant, run.id, {})).rejects.toThrow(/截图/);
    await pass(applicant, run.id, { screenshots: [1] });
    expect((await get(storeId)).title).toBe('旧店名'); // 人事还没改聚水潭，OA 不能先改
    await expect(pass(hr1, run.id, {})).rejects.toThrow(/截图/);
    const done = await pass(hr2, run.id, { screenshots: [2], note: '聚水潭已改' });
    expect(done.status).toBe('completed');
    const rec = await get(storeId);
    expect(rec.title).toBe('新店名');
    expect(rec.data).toMatchObject({ name: '新店名', formerNames: '旧店名', jushuitanShopName: '新店名' });
    const [log] = await ds.query("SELECT note FROM resource_change_logs WHERE company_id=? AND resource_type='stores' AND resource_id=? ORDER BY id DESC LIMIT 1", [admin.companyId, storeId]);
    expect(String(log?.note ?? '')).toContain(`流程 #${run.id}`);
  });

  it('再次改名：曾用名累积；最后一步新名被别家抢注则失败不改', async () => {
    const run = await flow.start(applicant, 'store-rename', { storeId: linkedId, newName: '抢注店', reason: 'x' });
    await toJst(run.id);
    await resources.create(admin, 'stores', { platform: 'douyin', name: '抢注店' });
    await expect(pass(hr1, run.id, { screenshots: [2] })).rejects.toThrow('已经有叫');
    expect((await get(linkedId)).title).toBe('已占用店');
    const again = await flow.start(applicant, 'store-rename', { storeId, newName: '第三个名', reason: 'x' });
    await toJst(again.id);
    await pass(hr1, again.id, { screenshots: [2] });
    expect((await get(storeId)).data.formerNames).toBe('新店名、旧店名');
  });
});
