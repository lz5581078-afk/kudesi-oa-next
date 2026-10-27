/** 组合装同步维护：批量签名入队、权限、归档任务与复查、基本售价同步、分类同步。全程假发送器，不连聚水潭。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { SPECIAL_PERMISSIONS } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FlowRun, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from '../resources/resources.service';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { CostService } from '../resources/cost.service';
import { OutboxService } from './outbox.service';
import { PriceSyncService } from './price-sync.service';
import { CategorySyncService } from './category-sync.service';
import { FakeJstSender } from './fake-jst-sender';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('组合装同步维护（真实数据库 + 假发送器）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let outbox: OutboxService;
  let tools: BundleToolsService;
  let price: PriceSyncService;
  let cat: CategorySyncService;
  let cost: CostService;
  let boss: AuthUser;
  let helper: AuthUser; // 只有“组合装同步维护”权限的普通员工
  let nobody: AuthUser; // 能看同步页，但没有组合装同步维护权限
  const fake = new FakeJstSender();
  const ids: Record<string, number> = {};

  const makeBundle = async (qty: number, platformCode: string) => {
    const plat = await svc.create(boss, 'finance-platforms', { code: platformCode, name: platformCode });
    const made = await tools.generate(boss, [{ role: 'main', baseCodeId: ids.bc, qty }], [{ platformId: plat.id, scenarioId: ids.scen, bundleCategoryId: ids.bcat }]);
    const id = made.created[0].id;
    await svc.changeStatus(boss, 'finance-bundles', id, 'verified');
    return id;
  };
  const upload = async (bundleId: number) => {
    const items = await outbox.items(boss, { type: 'finance-bundles', page: 1, pageSize: 50 });
    const it = items.rows.find((r) => r.id === bundleId)!;
    await outbox.enqueue(helper, 'finance-bundles', [bundleId], { signatures: { [bundleId]: it.signature } });
    await outbox.processCompany(boss.companyId);
    expect((await svc.get(boss, 'finance-bundles', bundleId)).data.jstStatus).toBe('synced');
  };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    svc = s.resources;
    outbox = new OutboxService(ds, svc);
    cost = new CostService(ds);
    tools = new BundleToolsService(ds, svc, outbox);
    price = new PriceSyncService(ds, outbox, cost, svc);
    cat = new CategorySyncService(ds, outbox);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `s${crypto.randomBytes(5).toString('hex')}`, name: '同步维护', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    helper = { id: u.id, companyId: c.id, name: '小同步', permissions: { isCompanyAdmin: false, allow: [SPECIAL_PERMISSIONS.financeBundleSync], deny: [] } };
    nobody = { id: u.id, companyId: c.id, name: '路人', permissions: { isCompanyAdmin: false, allow: ['finance.jst-sync.view'], deny: [] } };
    const root = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' })).id;
    const leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: root })).id;
    const p = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '苹果', categoryId: leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' });
    const bc = await svc.create(boss, 'finance-base-codes', { productId: p.id, code: 'APPLE-A', codeChangeReason: '测试' });
    await svc.changeStatus(boss, 'finance-base-codes', bc.id, 'verified');
    ids.bc = bc.id;
    ids.scen = (await svc.create(boss, 'finance-scenarios', { code: 'standard', name: '标准', segment: '' })).id;
    ids.bcat = (await svc.create(boss, 'finance-categories', { archiveType: 'bundle', name: '水果组合', code: 'SGZH' })).id;
    await outbox.setSwitch(boss, true, '测试');
    outbox.setSender(fake);
    // 基础编码先上传
    await outbox.enqueue(boss, 'finance-base-codes', [ids.bc]);
    await outbox.processCompany(boss.companyId);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('批量入队：必须有组合装同步维护权限；指纹对不上拒绝；一次最多 50 个由接口限制', async () => {
    ids.b1 = await makeBundle(2, 'TB');
    const items = await outbox.items(boss, { type: 'finance-bundles', page: 1, pageSize: 50 });
    const it = items.rows.find((r) => r.id === ids.b1)!;
    await expect(outbox.enqueue(nobody, 'finance-bundles', [ids.b1], { signatures: { [ids.b1]: it.signature } })).rejects.toThrow(/组合装同步维护/);
    await expect(outbox.enqueue(helper, 'finance-bundles', [ids.b1], { signatures: { [ids.b1]: 'wrong' } })).rejects.toThrow(/核对之后变了/);
    // 基础编码仍然只有管理员
    await expect(outbox.enqueue(helper, 'finance-base-codes', [ids.bc])).rejects.toThrow(/公司管理员/);
    await upload(ids.b1);
  });

  it('同步清单状态汇总是全量统计，也能按状态筛选（服务端分页）', async () => {
    ids.b2 = await makeBundle(3, 'TB2');
    const sum = await outbox.itemsSummary(boss, 'finance-bundles');
    expect(sum.total).toBeGreaterThanOrEqual(2);
    expect(Object.values(sum.counts).reduce((a, b) => a + b, 0)).toBe(sum.total);
    const notSynced = await outbox.items(boss, { type: 'finance-bundles', state: 'not_synced', page: 1, pageSize: 1 });
    expect(notSynced.total).toBe(sum.counts.not_synced ?? 0);
    expect(notSynced.rows.every((r) => r.state === 'not_synced')).toBe(true);
    expect(notSynced.rows.length).toBeLessThanOrEqual(1);
    await expect(outbox.itemsSummary(boss, 'finance-products')).rejects.toThrow(/不支持/);
  });

  it('基本售价：开关默认关；不齐全的被拦截并写日志；齐全后入队，价格开关关着不发送，打开后发送并回读', async () => {
    expect((await price.getSwitch(boss)).enabled).toBe(false);
    await expect(price.run(helper, {})).rejects.toThrow(/开关还没开/);
    await expect(price.setSwitch(helper, true)).rejects.toThrow(/公司管理员/);
    await price.setSwitch(boss, true, '测试');
    // 没有运费/利润率：被拦截
    let out = await price.run(helper, { ids: [ids.b1] });
    expect(out).toMatchObject({ queued: 0, blocked: 1 });
    expect((await svc.get(boss, 'finance-bundles', ids.b1)).data.jstPriceStatus).toBe('blocked');
    expect((await price.logs(helper, { bundleId: ids.b1, page: 1, pageSize: 10 })).rows[0].status).toBe('blocked');
    await svc.update(boss, 'finance-bundles', ids.b1, { manualFreight: 800, marginOverridePercent: 20, overrideReason: '测试' });
    await svc.changeStatus(boss, 'finance-bundles', ids.b1, 'verified').catch(() => undefined);
    const row = await cost.one(boss, ids.b1);
    expect(row.minPriceCents).toBeGreaterThan(0);
    // 构成/上传内容没变，只是价格相关设置变了，状态仍是已验证
    out = await price.run(helper, { ids: [ids.b1] });
    expect(out.queued).toBe(1);
    expect((await svc.get(boss, 'finance-bundles', ids.b1)).data.jstPriceStatus).toBe('confirming');
    // 同一价格不重复入队
    expect((await price.run(helper, { ids: [ids.b1] })).queued).toBe(0);
    // 价格开关关着：任务留在队列，不发送
    await outbox.setSwitch(boss, false, '关价格', 'jst_price');
    const before = fake.sent.length;
    await outbox.processCompany(boss.companyId);
    expect(fake.sent.length).toBe(before);
    await outbox.setSwitch(boss, true, '开价格', 'jst_price');
    expect((await outbox.processCompany(boss.companyId)).sent).toBe(1);
    const sent = fake.sent[fake.sent.length - 1];
    expect(sent.kind).toBe('bundle_price_update');
    expect(sent.payload).toMatchObject({ compose_sale_price: row.minPriceCents! / 100, preserveChildPrices: true });
    const b = await svc.get(boss, 'finance-bundles', ids.b1);
    expect(b.data.jstPriceStatus).toBe('success');
    expect(b.data.jstPriceCents).toBe(row.minPriceCents);
    // 回读到的子商品没被覆盖
    expect((fake.remote.get(String(b.data.code)) as { childList?: unknown[] }).childList?.length).toBe(1);
    // 价格已经同步：再跑算“相同”
    expect(await price.run(helper, { ids: [ids.b1] })).toMatchObject({ queued: 0, same: 1 });
    // 没有 product.price.view 的人看不到价格
    const seen = await price.logs({ ...nobody, permissions: { isCompanyAdmin: false, allow: [SPECIAL_PERMISSIONS.financeBundleSync], deny: [] } }, { page: 1, pageSize: 10 });
    expect(seen.rows.every((r: { priceCents: number | null }) => r.priceCents === null)).toBe(true);
    // 总开关一键停止：价格任务也不发
    await svc.update(boss, 'finance-bundles', ids.b1, { manualFreight: 900, overrideReason: '涨运费' });
    expect((await price.run(helper, { ids: [ids.b1] })).queued).toBe(1);
    await outbox.setSwitch(boss, false, '一键停止');
    const n = fake.sent.length;
    expect((await outbox.processCompany(boss.companyId)).blocked).toBe(true);
    expect(fake.sent.length).toBe(n);
    await outbox.setSwitch(boss, true, '恢复');
    fake.readMode = 'mismatch';
    expect((await outbox.processCompany(boss.companyId)).failed).toBe(1);
    fake.readMode = 'ok';
    expect((await svc.get(boss, 'finance-bundles', ids.b1)).data.jstPriceStatus).toBe('confirming'); // 结果未知，等人确认
    const k = fake.sent.length;
    await outbox.processCompany(boss.companyId);
    expect(fake.sent.length).toBe(k); // 不自动重发
  });

  it('归档任务：已上传聚水潭的组合归档后建任务；发送、回查确认后成功；复查只读', async () => {
    ids.b2 = await makeBundle(3, 'JD');
    await upload(ids.b2);
    await expect(tools.archive(nobody, ids.b2, '不用了', true)).rejects.toThrow(/组合装同步维护/);
    await tools.archive(helper, ids.b2, '不用了', true);
    let jobs = (await outbox.archiveJobs(helper)).rows as Array<{ id: number; bundleId: number; status: string }>;
    expect(jobs.find((j) => j.bundleId === ids.b2)?.status).toBe('pending');
    await expect(outbox.recheckArchiveJob(helper, jobs.find((j) => j.bundleId === ids.b2)!.id)).rejects.toThrow(/还在队列/);
    const before = fake.sent.length;
    await outbox.processCompany(boss.companyId);
    expect(fake.sent.length).toBe(before + 1);
    jobs = (await outbox.archiveJobs(helper)).rows as Array<{ id: number; bundleId: number; status: string }>;
    expect(jobs.find((j) => j.bundleId === ids.b2)?.status).toBe('success');
    const code = String((await svc.get(boss, 'finance-bundles', ids.b2)).data.code);
    expect(fake.remote.get(code)?.enabled).toBe('禁用');
  });

  it('在办的 SKU 申请用到这个组合：不能归档，也不能提交/发布构成修订', async () => {
    ids.b4 = await makeBundle(5, 'KS');
    const b = await svc.get(boss, 'finance-bundles', ids.b4);
    const def = await ds.query("SELECT id FROM flow_definitions WHERE company_id = ? LIMIT 1", [boss.companyId]);
    const defId = def[0]?.id ?? 0;
    const run = await ds.manager.save(FlowRun, ds.manager.create(FlowRun, {
      companyId: boss.companyId, definitionId: defId, templateKey: 'sku-batch-apply', title: '测试申请', status: 'running', requesterId: boss.id, currentStepKey: 'review',
      payload: { scenarioId: ids.scen, platformIds: [b.data.platformId], specs: [{ name: '规格A', main: [{ baseCodeId: ids.bc, qty: 5 }], gift: [] }] }, stepsSnapshot: [], escalateUserIds: [],
    }));
    await expect(tools.archive(boss, ids.b4, '不用了', false)).rejects.toThrow(/SKU 批量申请/);
    await expect(tools.createRevision(boss, ids.b4, '改构成', [{ role: 'main', baseCodeId: ids.bc, qty: 6 }])).rejects.toThrow(/SKU 批量申请/);
    await ds.manager.update(FlowRun, { id: run.id }, { status: 'completed' });
    await expect(tools.archive(boss, ids.b4, '不用了', false)).resolves.toMatchObject({ ok: true });
  });

  it('归档任务：回查发现还是启用 → 失败；复查读到已禁用 → 成功；复查不会发送任何写入', async () => {
    ids.b3 = await makeBundle(4, 'PDD');
    await upload(ids.b3);
    const code = String((await svc.get(boss, 'finance-bundles', ids.b3)).data.code);
    await tools.archive(boss, ids.b3, '停用', true);
    fake.readMode = 'mismatch'; // 回读：禁用状态读不到（仍然读到旧内容）
    const original = fake.send.bind(fake);
    fake.send = async (job) => { if (job.kind === 'bundle_disable') { fake.sent.push(job); return; } return original(job); }; // 假装发出去了但没生效
    await outbox.processCompany(boss.companyId);
    fake.send = original;
    fake.readMode = 'ok';
    let row = ((await outbox.archiveJobs(boss)).rows as Array<{ id: number; bundleId: number; status: string; message: string }>).find((j) => j.bundleId === ids.b3)!;
    expect(row.status).toBe('failed');
    const n = fake.sent.length;
    let r = await outbox.recheckArchiveJob(boss, row.id);
    expect(r.status).toBe('failed'); // 聚水潭上仍然启用
    expect(fake.sent.length).toBe(n);
    fake.remote.set(code, { ...(fake.remote.get(code) ?? {}), enabled: '禁用' });
    r = await outbox.recheckArchiveJob(boss, row.id);
    expect(r.status).toBe('success');
    row = ((await outbox.archiveJobs(boss)).rows as Array<{ id: number; bundleId: number; status: string; message: string }>).find((j) => j.bundleId === ids.b3)!;
    expect(row.status).toBe('success');
  });

  it('分类同步：预览 → 确认入队 → 发送回读 → 改名只更新；没有聚水潭读取能力时拒绝；非管理员不能操作', async () => {
    const r1 = (await svc.create(boss, 'finance-categories', { archiveType: 'bundle', name: '礼盒', code: 'LH' })).id;
    const r2 = (await svc.create(boss, 'finance-categories', { archiveType: 'bundle', name: '大礼盒', code: 'DLH', parentId: r1 })).id;
    await expect(cat.preview(helper, 'bundle')).rejects.toThrow(/公司管理员/);
    fake.targetKey = 'shop-A';
    const pv = await cat.preview(boss, 'bundle');
    expect(pv.changes.filter((c) => c.action === 'create').map((c) => c.path).sort()).toEqual(['水果组合', '礼盒', '礼盒 / 大礼盒'].sort());
    expect(pv.conflicts).toBe(0);
    await expect(cat.execute(boss, 'bundle', 'stale', true)).rejects.toThrow(/已变化/);
    await expect(cat.execute(boss, 'bundle', pv.signature, false)).rejects.toThrow(/确认/);
    const ex = await cat.execute(boss, 'bundle', pv.signature, true);
    expect(ex.queued).toBe(3);
    const sentBefore = fake.sent.length;
    await outbox.processCompany(boss.companyId);
    expect(fake.sent.length - sentBefore).toBe(3);
    const remote = [...fake.categories.values()];
    const parent = remote.find((c) => c.name === '礼盒')!;
    expect(remote.find((c) => c.name === '大礼盒')!.parentId).toBe(parent.id); // 子分类挂到了刚新增的上级下
    // 再预览：没有差异
    expect((await cat.preview(boss, 'bundle')).changes).toHaveLength(0);
    // 改名：只更新
    await svc.update(boss, 'finance-categories', r2, { name: '超大礼盒' });
    const pv2 = await cat.preview(boss, 'bundle');
    expect(pv2.changes.map((c) => c.action)).toEqual(['update']);
    await cat.execute(boss, 'bundle', pv2.signature, true);
    await outbox.processCompany(boss.companyId);
    expect([...fake.categories.values()].find((c) => c.id !== parent.id && c.name === '超大礼盒')).toBeTruthy();
    // 聚水潭上被外部改名：冲突，不执行
    const link = [...fake.categories.values()].find((c) => c.name === '超大礼盒')!;
    fake.categories.set(link.id, { ...link, name: '被人改了' });
    const pv3 = await cat.preview(boss, 'bundle');
    expect(pv3.conflicts).toBe(1);
    await expect(cat.execute(boss, 'bundle', pv3.signature, true)).rejects.toThrow(/冲突/);
    fake.categories.set(link.id, link);
    // 同步记录
    const runs = await cat.runs(boss, 1);
    expect(runs.rows[0].status).toBe('success');
    // 本地分类停用 = 聚水潭停用
    await svc.changeStatus(boss, 'finance-categories', r2, 'inactive', '不用了');
    const pv4 = await cat.preview(boss, 'bundle');
    expect(pv4.changes.map((c) => c.action)).toEqual(['update']);
    expect((pv4.changes[0].after as { enable: boolean }).enable).toBe(false);
    fake.targetKey = undefined;
    await expect(cat.preview(boss, 'bundle')).rejects.toThrow(/企业编号|接入/);
  });
});
