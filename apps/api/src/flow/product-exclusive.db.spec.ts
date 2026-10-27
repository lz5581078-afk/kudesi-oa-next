/** 专属品领取流程（申请 → 审批 → 专属生效）的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_d npx jest product-exclusive */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import type { StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { OutboxService } from '../outbox/outbox.service';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { FlowService } from './flow.service';
import { ExclusiveService } from './exclusive.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('专属品领取流程（真实数据库）', () => {
  let ds: DataSource;
  let flow: FlowService;
  let resources: ReturnType<typeof buildServices>['resources'];
  let admin: AuthUser, alice: AuthUser, bob: AuthUser, approver: AuthUser, outsider: AuthUser;
  const ids: Record<string, number> = {};
  const key = () => crypto.randomBytes(8).toString('hex') + 'abcd';
  const mkUser = async (companyId: number, account: string, name: string, extra: Partial<User> = {}) =>
    (await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra }))).id;
  const au = (id: number, companyId: number, name: string, allow: string[] = []): AuthUser => ({ id, companyId, name, permissions: { isCompanyAdmin: false, allow, deny: [] } });
  const step = (k: string, name: string, type: StepDef['type'], assigneeId?: number): StepDef =>
    ({ key: k, name, type, ...(type === 'submit' ? { assignee: { source: 'requester' } } : assigneeId ? { assignee: { source: 'employee', id: assigneeId } } : {}) }) as StepDef;
  const apply = (u: AuthUser, baseCodeId: number, over: Record<string, unknown> = {}) => flow.start(u, 'product-exclusive', { baseCodeId, reason: '准备主推', ...over }, key());
  const approve = (u: AuthUser, run: Awaited<ReturnType<FlowService['start']>>, periodDays: unknown) => flow.pass(u, run.id, { revision: run.revision, stepId: run.activeStep!.id, form: { periodDays } });
  const grants = async () => (await ds.manager.find(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-product-exclusives' } }));

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    resources = s.resources;
    const outbox = new OutboxService(ds, resources);
    flow = new FlowService(ds, resources, new FinanceDocumentsService(ds), new BundleToolsService(ds, resources, outbox), outbox);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `k${crypto.randomBytes(5).toString('hex')}`, name: '专属品测试', status: 'active' }));
    const c2 = await ds.manager.save(Company, ds.manager.create(Company, { code: `k${crypto.randomBytes(5).toString('hex')}`, name: '别家公司', status: 'active' }));
    admin = { id: await mkUser(c.id, 'admin', '管理员', { isCompanyAdmin: true }), companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    alice = au(await mkUser(c.id, 'alice', '小甲'), c.id, '小甲', ['flow.apply.view', 'resource.finance-product-exclusives.view', 'resource.finance-product-exclusives.edit']);
    bob = au(await mkUser(c.id, 'bob', '小乙'), c.id, '小乙', ['flow.apply.view', 'resource.finance-product-exclusives.view', 'resource.finance-product-exclusives.edit']);
    approver = au(await mkUser(c.id, 'appr', '审批人'), c.id, '审批人', ['resource.finance-product-exclusives.view', 'resource.finance-product-exclusives.edit']);
    outsider = { id: await mkUser(c2.id, 'out', '外人', { isCompanyAdmin: true }), companyId: c2.id, name: '外人', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };

    const root = await resources.create(admin, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' });
    const leaf = (await resources.create(admin, 'finance-categories', { archiveType: 'raw', name: '水果下级', code: 'SG1', parentId: root.id })).id;
    const brandA = (await resources.create(admin, 'finance-brands', { name: '甲品牌', code: 'JA' })).id;
    const brandB = (await resources.create(admin, 'finance-brands', { name: '乙品牌', code: 'YB' })).id;
    const zero = { zeroValueReason: '运费：无\n装卸费：无' };
    const baseCode = async (name: string, brandId: number, specQty: number, code: string) => {
      const p = await resources.create(admin, 'finance-products', { archiveType: 'raw', name, categoryId: leaf, brandId, purchaseSpec: '千克', specQty, specUnit: 'KG', purchasePrice: 1000, freight: 0, handlingFee: 0, ...zero });
      const bc = await resources.create(admin, 'finance-base-codes', { productId: p.id, code, codeChangeReason: '测试' });
      return bc.id;
    };
    ids.apple1 = await baseCode('红富士', brandA, 1, 'APPLE-1');
    ids.apple2 = await baseCode('红富士', brandA, 5, 'APPLE-5'); // 同品种不同规格：同一族
    ids.appleB = await baseCode('红富士', brandB, 1, 'APPLE-B'); // 不同品牌：另一族
    ids.mango = await baseCode('芒果', brandA, 1, 'MANGO-1');

    await flow.saveDraft(admin, 'product-exclusive', [step('apply', '提交申请', 'submit'), step('approve', '审批', 'approval', approver.id), step('end', '结束', 'end')], []);
    await flow.publish(admin, 'product-exclusive');
  });
  afterAll(async () => { await ds?.destroy(); });

  it('发起：要有申请权限和领取原因，商品必须是本公司有效的基础商品', async () => {
    await expect(apply(alice, ids.apple1, { reason: '  ' })).rejects.toThrow(/领取原因|必填/);
    await expect(apply(alice, 999999)).rejects.toThrow(/有效的基础商品/);
    await expect(apply(outsider, ids.apple1)).rejects.toThrow();
    const noApply = au(approver.id, admin.companyId, '审批人', []);
    await expect(apply(noApply, ids.apple1)).rejects.toThrow(/权限/);
  });

  it('审批通过生成专属：专属期 1 到 3650 天；记下专属人、审批人、到期时间；同一族不能再领', async () => {
    const run = await apply(alice, ids.apple1);
    expect(run.title).toContain('专属品领取');
    // 同一族已有人在申请：同品种不同规格也不行；不同品牌（另一族）、别的品种可以
    await expect(apply(bob, ids.apple2)).rejects.toThrow(/正在申请专属领取/);
    const other = await apply(bob, ids.appleB);
    const mango = await apply(bob, ids.mango);
    await flow.stop(bob, other.id, 'cancel', { revision: other.revision, stepId: other.activeStep!.id, reason: '换品牌了' }).catch(() => flow.withdraw(bob, other.id, { revision: other.revision }));
    await flow.withdraw(bob, mango.id, { revision: mango.revision });
    await expect(approve(approver, run, 0)).rejects.toThrow(/1 至 3650/);
    await expect(approve(approver, run, 3651)).rejects.toThrow(/1 至 3650/);
    await expect(approve(approver, run, 1.5)).rejects.toThrow(/整数/);
    await expect(approve(alice, run, 30)).rejects.toThrow(/不是你办理/);
    const done = await approve(approver, run, 30);
    expect(done.status).toBe('completed');
    const g = (await grants()).find((r) => r.data.runId === run.id)!;
    expect(g.status).toBe('active');
    expect(g.data).toMatchObject({ ownerName: '小甲', approverName: '审批人', baseCodeId: ids.apple1, productName: '红富士' });
    const days = (Date.parse(String(g.data.endsAt)) - Date.parse(String(g.data.startsAt))) / 86400000;
    expect(Math.round(days)).toBe(30);
    // 已有有效专属：同族任何规格都不能再领
    await expect(apply(bob, ids.apple1)).rejects.toThrow(/已有有效专属/);
    await expect(apply(bob, ids.apple2)).rejects.toThrow(/已有有效专属/);
    // 另一族不受影响
    const ok = await apply(bob, ids.mango);
    await flow.withdraw(bob, ok.id, { revision: ok.revision });
  });

  it('专属记录不能手工新增或修改；本人、原审批人、管理员可取消（必须写原因），别人不行；取消后恢复可领取', async () => {
    const g = (await grants())[0];
    await expect(resources.create(admin, 'finance-product-exclusives', { label: 'x', baseCodeId: ids.mango })).rejects.toThrow(/只能通过/);
    await expect(resources.update(admin, 'finance-product-exclusives', g.id, { productName: '改名' })).rejects.toThrow(/只能取消/);
    await expect(resources.changeStatus(bob, 'finance-product-exclusives', g.id, 'cancelled', '我想要')).rejects.toThrow(/本人、原审批人或管理员/);
    await expect(resources.changeStatus(alice, 'finance-product-exclusives', g.id, 'cancelled')).rejects.toThrow(/原因/);
    const done = await resources.changeStatus(alice, 'finance-product-exclusives', g.id, 'cancelled', '不做了');
    expect(done.status).toBe('cancelled');
    expect(done.data.cancelledAt).toBeTruthy();
    await expect(resources.changeStatus(admin, 'finance-product-exclusives', g.id, 'active')).rejects.toThrow(/不能再改/);
    const again = await apply(bob, ids.apple2);
    expect(again.status).toBe('running');
    const fin = await approve(approver, again, 10);
    expect(fin.status).toBe('completed');
  });

  it('到期自动解除；已领取的编码冻结在领取时的族里，资料改了也不换族', async () => {
    const g = (await grants()).find((r) => r.status === 'active')!;
    await expect(apply(alice, ids.apple1)).rejects.toThrow(/已有有效专属/);
    // 冻结：把 apple1 的品种改成别的，它仍然属于已领取的那一族
    await resources.update(admin, 'finance-base-codes', ids.apple1, { varietyName: '另一个品种' });
    await expect(apply(alice, ids.apple1)).rejects.toThrow(/已有有效专属/);
    // 到期
    await ds.manager.update(ResourceRecord, { id: g.id }, { data: { ...g.data, endsAt: new Date(Date.now() - 1000).toISOString() } });
    const run = await apply(alice, ids.apple1);
    expect(run.status).toBe('running');
    await flow.withdraw(alice, run.id, { revision: run.revision });
  });

  it('废除/拒绝的申请释放名额；已生效的申请单不能废除', async () => {
    const run = await apply(alice, ids.mango);
    await expect(apply(bob, ids.mango)).rejects.toThrow(/正在申请/);
    await flow.withdraw(alice, run.id, { revision: run.revision });
    const again = await apply(bob, ids.mango);
    expect(again.status).toBe('running');
    await flow.withdraw(bob, again.id, { revision: again.revision });
  });

  it('审批人也可以指定到期日（二选一）：必须在今天之后、不超过 3650 天', async () => {
    const run = await apply(bob, ids.appleB);
    const pass = (form: Record<string, unknown>) => flow.pass(approver, run.id, { revision: run.revision, stepId: run.activeStep!.id, form });
    await expect(pass({})).rejects.toThrow(/天数.*到期日|到期日/);
    await expect(pass({ periodDays: 30, endsAt: '2099-01-01' })).rejects.toThrow(/二选一/);
    await expect(pass({ endsAt: '2020-01-01' })).rejects.toThrow(/晚于今天/);
    await expect(pass({ endsAt: '2999-01-01' })).rejects.toThrow(/最长/);
    await expect(pass({ endsAt: '明天' })).rejects.toThrow(/格式/);
    const day = new Date(Date.now() + 20 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const done = await pass({ endsAt: day });
    expect(done.status).toBe('completed');
    const g = (await grants()).find((r) => r.data.runId === run.id)!;
    expect(String(g.data.endsAt)).toBe(new Date(`${day}T23:59:59+08:00`).toISOString());
  });

  it('领取页接口：商品清单标出专属/申请中/可领取并按分类、关键字、只看可领取筛选；专属记录与取消按人判断', async () => {
    const svc = new ExclusiveService(ds, resources);
    const pend = await apply(alice, ids.mango);
    const all = await svc.options(bob, {});
    const by = (n: string) => all.rows.find((r) => r.code === n) as { exclusive: { ownerName: string; mine: boolean } | null; pending: { requesterName: string; mine: boolean } | null };
    expect(by('APPLE-B').exclusive).toMatchObject({ ownerName: '小乙', mine: true });
    expect(by('MANGO-1').pending).toMatchObject({ requesterName: '小甲', mine: false });
    expect((await svc.options(bob, { onlyFree: true })).rows.every((r) => !r.exclusive && !r.pending)).toBe(true);
    expect((await svc.options(bob, { keyword: '芒果' })).rows.map((r) => r.code)).toEqual(['MANGO-1']);
    expect((await svc.options(bob, { categoryId: all.categories.find((c) => c.name === '水果')!.id })).total).toBe(all.total);
    expect((await svc.options(bob, { categoryId: 999999 })).total).toBe(0);
    expect((await svc.options(outsider, {})).total).toBe(0);
    await flow.withdraw(alice, pend.id, { revision: pend.revision });

    const list = (await svc.grants(alice)).rows;
    const mine = list.find((g) => g.ownerName === '小乙' && g.status === 'active')!;
    expect(mine.canCancel).toBe(false);
    expect((await svc.grants(bob)).rows.find((g) => g.id === mine.id)!.canCancel).toBe(true);
    expect((await svc.grants(approver)).rows.find((g) => g.id === mine.id)!.canCancel).toBe(true);
    expect((await svc.grants(outsider)).rows).toEqual([]);
    await expect(svc.cancel(alice, mine.id, '想要')).rejects.toThrow(/本人、原审批人或管理员/);
    await expect(svc.cancel(bob, mine.id, '   ')).rejects.toThrow(/原因/);
    await expect(svc.cancel(outsider, mine.id, '串公司')).rejects.toThrow(/没有这条/);
    await svc.cancel(bob, mine.id, '放弃');
    const after = (await svc.grants(bob)).rows.find((g) => g.id === mine.id)!;
    expect(after).toMatchObject({ status: 'cancelled', cancelReason: '放弃', canCancel: false });
    expect((await svc.options(alice, {})).rows.find((r) => r.code === 'APPLE-B')).toMatchObject({ exclusive: null });
  });
});
