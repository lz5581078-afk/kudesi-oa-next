/** SKU 批量申请流程（运营 → 仓库 → 财务）的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_e npx jest sku-apply */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import type { StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Notification, ResourceRecord, User } from '../entities';
import { OutboxService } from '../outbox/outbox.service';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { FlowService } from './flow.service';
import { SkuApplyService } from './sku-apply.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('SKU 批量申请流程（真实数据库）', () => {
  let ds: DataSource;
  let flow: FlowService;
  let sku: SkuApplyService;
  let resources: ReturnType<typeof buildServices>['resources'];
  let admin: AuthUser, ops: AuthUser, wh: AuthUser, fin: AuthUser, finNoPerm: AuthUser, stranger: AuthUser, noApply: AuthUser;
  const ids: Record<string, number> = {};
  const key = () => crypto.randomBytes(8).toString('hex') + 'abcd';
  const mkUser = async (companyId: number, account: string, name: string, extra: Partial<User> = {}) =>
    (await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra }))).id;
  const au = (id: number, companyId: number, name: string, allow: string[] = []): AuthUser => ({ id, companyId, name, permissions: { isCompanyAdmin: false, allow, deny: [] } });
  const step = (k: string, name: string, type: StepDef['type'], assigneeId?: number): StepDef =>
    ({ key: k, name, type, ...(type === 'submit' ? { assignee: { source: 'requester' } } : assigneeId ? { assignee: { source: 'employee', id: assigneeId } } : {}) }) as StepDef;

  const spec = (name: string, main: number, over: Record<string, unknown> = {}) => ({ name, main: [{ baseCodeId: main, qty: 2 }], gift: [], ...over });
  const payload = (specs: unknown[], over: Record<string, unknown> = {}) => ({ batchName: '10 月新品', scenarioId: ids.scen, platformIds: [ids.tb, ids.dy], specs, bundleCategoryId: ids.bcat, ...over });
  const whLines = (over: Record<string, unknown> = {}) => ({
    lines: [{ role: 'package', baseCodeId: ids.boxBc, qty: 1 }, { role: 'label', baseCodeId: ids.labelBc, qty: 1 }, { role: 'labor', laborId: ids.labor, qty: 1 }],
    notRequired: { other: '没有其他物料' }, ...over,
  });
  const whPass = (u: AuthUser, run: Awaited<ReturnType<FlowService['start']>>, config: unknown) => flow.pass(u, run.id, { revision: run.revision, stepId: run.activeStep!.id, form: { config } });
  const finPass = (u: AuthUser, run: Awaited<ReturnType<FlowService['start']>>, form: Record<string, unknown> = { confirmed: true }) => flow.pass(u, run.id, { revision: run.revision, stepId: run.activeStep!.id, form });
  const toWarehouse = async (specs: unknown[], over: Record<string, unknown> = {}) => flow.start(ops, 'sku-batch-apply', payload(specs, over), key());
  const toReview = async (specs: unknown[], configs?: unknown[]) => {
    const run = await toWarehouse(specs);
    return whPass(wh, run, configs ?? specs.map(() => whLines()));
  };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    resources = s.resources;
    const outbox = new OutboxService(ds, resources);
    const bundles = new BundleToolsService(ds, resources, outbox);
    flow = new FlowService(ds, resources, new FinanceDocumentsService(ds), bundles, outbox);
    sku = new SkuApplyService(ds, flow, bundles);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `k${crypto.randomBytes(5).toString('hex')}`, name: 'SKU申请测试', status: 'active' }));
    admin = { id: await mkUser(c.id, 'admin', '管理员', { isCompanyAdmin: true }), companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    ops = au(await mkUser(c.id, 'ops', '运营'), c.id, '运营', ['flow.apply.view']);
    wh = au(await mkUser(c.id, 'wh', '仓库'), c.id, '仓库');
    fin = au(await mkUser(c.id, 'fin', '财务'), c.id, '财务', ['resource.finance-bundles.create', 'resource.finance-bundles.edit', 'finance.jst-sync.view', 'product.cost.view']);
    finNoPerm = au(await mkUser(c.id, 'fin2', '财务二'), c.id, '财务二');
    stranger = au(await mkUser(c.id, 'str', '路人'), c.id, '路人', ['flow.apply.view']);
    noApply = au(await mkUser(c.id, 'na', '无权限'), c.id, '无权限');

    // ---- 商品资料 ----
    const cat = async (archiveType: string, name: string, code: string) => {
      const root = await resources.create(admin, 'finance-categories', { archiveType, name, code });
      return (await resources.create(admin, 'finance-categories', { archiveType, name: `${name}下级`, code: `${code}1`, parentId: root.id })).id;
    };
    const rawLeaf = await cat('raw', '水果', 'SG');
    const shipLeaf = await cat('shipping_material', '发货物料', 'FH');
    const pkgLeaf = await cat('package', '包装', 'BZ');
    const zero = { zeroValueReason: '运费：无\n装卸费：无' };
    const baseCode = async (productData: Record<string, unknown>, code: string) => {
      const p = await resources.create(admin, 'finance-products', { ...productData, freight: 0, handlingFee: 0, ...zero });
      const bc = await resources.create(admin, 'finance-base-codes', { productId: p.id, code, codeChangeReason: '测试' });
      await resources.changeStatus(admin, 'finance-base-codes', bc.id, 'verified');
      return bc.id;
    };
    ids.appleBc = await baseCode({ archiveType: 'raw', name: '苹果', categoryId: rawLeaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000 }, 'APPLE-A');
    ids.mangoBc = await baseCode({ archiveType: 'raw', name: '芒果', categoryId: rawLeaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 2000 }, 'MANGO-A');
    ids.pearBc = await baseCode({ archiveType: 'raw', name: '梨', categoryId: rawLeaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1500 }, 'PEAR-A');
    ids.giftBc = await baseCode({ archiveType: 'shipping_material', name: '小赠品', categoryId: shipLeaf, specQty: 1, specUnit: 'PCS', weightManual: true, weightG: 50, purchasePrice: 100 }, 'GIFT-A');
    ids.labelBc = await baseCode({ archiveType: 'shipping_material', name: '标签', categoryId: shipLeaf, specQty: 1, specUnit: 'PCS', weightManual: true, weightG: 1, purchasePrice: 10 }, 'LABEL-A');
    ids.boxBc = await baseCode({ archiveType: 'package', name: '纸箱', categoryId: pkgLeaf, specQty: 1, specUnit: 'PCS', capacities: '5斤', weightManual: true, weightG: 200, purchasePrice: 300 }, 'BOX-A');
    // 人工
    const v = await resources.create(admin, 'finance-labor-versions', { versionCode: 'V1', versionName: '测试版', effectiveFrom: '2026-01-01' }, 'active');
    const lc = await resources.create(admin, 'finance-labor-categories', { versionId: v.id, name: '车间' });
    const wt = await resources.create(admin, 'finance-labor-work-types', { name: '包装' });
    const unit = await resources.create(admin, 'finance-labor-units', { name: '元/个' });
    ids.labor = (await resources.create(admin, 'finance-labor-costs', { versionId: v.id, workTypeId: wt.id, unitId: unit.id, workName: '装箱', unitPrice: 150, archiveCategoryId: lc.id })).id;
    ids.bcat = (await resources.create(admin, 'finance-categories', { archiveType: 'bundle', name: '水果组合', code: 'SGZH' })).id;
    const giftProductId = (await resources.get(admin, 'finance-base-codes', ids.giftBc)).data.productId as number;
    await resources.update(admin, 'finance-products', giftProductId, { giftShortName: '小赠品', giftCodeShortName: 'XZP' });
    ids.tb = (await resources.create(admin, 'finance-platforms', { code: 'TB', name: '淘宝' })).id;
    ids.dy = (await resources.create(admin, 'finance-platforms', { code: 'DY', name: '抖音' })).id;
    ids.scen = (await resources.create(admin, 'finance-scenarios', { code: 'standard', name: '标准', segment: '' })).id;

    // 子商品已在聚水潭上（组合装上传前的依赖检查）
    await ds.query("UPDATE resource_records SET data = JSON_SET(data, '$.jstUploadedCode', JSON_UNQUOTE(JSON_EXTRACT(data, '$.code'))) WHERE company_id = ? AND type = 'finance-base-codes'", [admin.companyId]);
    // ---- 流程配置并发布 ----
    await flow.saveDraft(admin, 'sku-batch-apply', [step('apply', '运营申请', 'submit'), step('warehouse', '仓库完善', 'execute', wh.id), step('review', '财务审核', 'finance', fin.id), step('end', '结束', 'end')], []);
    await flow.publish(admin, 'sku-batch-apply');
  });
  afterAll(async () => { await ds?.destroy(); });

  it('发起要有申请权限；主品必须是允许的档案类型、已验证、有成本；规格不能重名；至少一个平台', async () => {
    await expect(flow.start(noApply, 'sku-batch-apply', payload([spec('A', ids.appleBc)]))).rejects.toThrow(/权限/);
    await expect(flow.start(ops, 'sku-batch-apply', payload([]))).rejects.toThrow(/规格清单/);
    await expect(flow.start(ops, 'sku-batch-apply', payload([spec('A', ids.boxBc)]))).rejects.toThrow(/不能当作主商品/);
    await expect(flow.start(ops, 'sku-batch-apply', payload([spec('A', ids.appleBc), spec('a', ids.mangoBc)]))).rejects.toThrow(/重复/);
    await expect(flow.start(ops, 'sku-batch-apply', payload([{ name: 'X', main: [], gift: [] }]))).rejects.toThrow(/主商品/);
    await expect(flow.start(ops, 'sku-batch-apply', payload([spec('A', ids.appleBc)], { platformIds: [] }))).rejects.toThrow(/不能为空|平台/);
    await expect(flow.start(ops, 'sku-batch-apply', payload([spec('A', 999999)]))).rejects.toThrow(/不存在/);
    await expect(flow.start(ops, 'sku-batch-apply', payload([spec('A', ids.appleBc), spec('B', ids.appleBc)]))).rejects.toThrow(/完全一样/);
    // 赠品可以是发货物料；同商品数量合并
    const run = await flow.start(ops, 'sku-batch-apply', payload([{ name: 'G', main: [{ baseCodeId: ids.pearBc, qty: 1 }, { baseCodeId: ids.pearBc, qty: 2 }], gift: [{ baseCodeId: ids.giftBc, qty: 1 }] }]), key());
    expect(run.status).toBe('running');
    expect((run.payload.specs as { main: { qty: number }[] }[])[0].main).toEqual([{ baseCodeId: ids.pearBc, qty: 3 }]);
    expect(run.activeStep!.key).toBe('warehouse');
    expect(run.title).toContain('1 个规格');
    await flow.withdraw(ops, run.id, { revision: run.revision });
  });

  it('仓库：四类每类要么选物料要么写不需要的原因；包装只能选包装档案；不是办理人不能办', async () => {
    const run = await toWarehouse([spec('W', ids.appleBc)]);
    const bad = (config: unknown) => whPass(wh, run, config);
    await expect(whPass(stranger, run, [whLines()])).rejects.toThrow(/不是你办理/);
    await expect(bad([whLines({ notRequired: {} })])).rejects.toThrow(/其他打包材料/);
    await expect(bad([{ lines: [{ role: 'package', baseCodeId: ids.appleBc, qty: 1 }], notRequired: { label: 'x', other: 'x', labor: 'x' } }])).rejects.toThrow(/不能当作包装/);
    await expect(bad([whLines(), whLines()])).rejects.toThrow(/对不上/);
    await expect(bad([{ lines: [], notRequired: { package: '客户自备', label: '无', other: '无' } }])).rejects.toThrow(/人工/);
    const next = await bad([{ lines: [], notRequired: { package: '客户自备', label: '无', other: '无', labor: '无' } }]);
    expect(next.activeStep!.key).toBe('review');
    const back = await flow.returnBack(fin, next.id, { revision: next.revision, stepId: next.activeStep!.id, reason: '先退回' });
    expect(back.activeStep!.key).toBe('warehouse');
    await flow.stop(wh, run.id, 'cancel', { revision: back.revision, stepId: back.activeStep!.id, reason: '清理' });
  });

  it('财务通过：每个规格×平台生成组合编码并验证，记下来源申请单；通过后可加入聚水潭同步队列（只入队）', async () => {
    const run = await toReview([spec('甲', ids.appleBc), spec('乙', ids.mangoBc)]);
    expect(run.activeStep!.key).toBe('review');
    // 预览：能看到会生成的编码；成本只给有成本权限的人
    const prev = await sku.preview(fin, run.id);
    expect(prev.specs).toHaveLength(2);
    expect(prev.specs[0].targets).toHaveLength(2);
    expect(prev.specs[0].totalCost).toBeGreaterThan(0);
    const asOps = await sku.preview(ops, run.id);
    expect(asOps.specs[0].totalCost).toBeUndefined();
    expect(asOps.specs[0].lines[0].cost).toBeUndefined();
    await expect(sku.preview(stranger, run.id)).rejects.toThrow(/权限/);
    // 权限与确认
    await expect(finPass(finNoPerm, run)).rejects.toThrow(/不是你办理/);
    await expect(finPass(fin, run, {})).rejects.toThrow(/不能为空|勾选/);
    await expect(finPass(fin, run, { confirmed: false })).rejects.toThrow(/勾选/);
    const done = await finPass(fin, run, { confirmed: true, syncToJst: true });
    expect(done.status).toBe('completed');
    const bundles = await ds.manager.find(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-bundles' } });
    expect(bundles).toHaveLength(4);
    for (const b of bundles) {
      expect(b.status).toBe('verified');
      expect(b.data.sourceRunId).toBe(run.id);
    }
    const lines = await ds.manager.find(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-bundle-lines' } });
    expect(lines.filter((l) => l.data.role === 'package')).toHaveLength(4);
    expect(lines.filter((l) => l.data.role === 'labor')).toHaveLength(4);
    // 只入队：队列里有 4 条待发送，没有真的发出
    const jobs = await ds.query("SELECT status FROM outbox_jobs WHERE company_id = ? AND resource_type = 'finance-bundles'", [admin.companyId]);
    expect(jobs).toHaveLength(4);
    expect(jobs.every((j: { status: string }) => j.status === 'pending')).toBe(true);
    // 申请人收到结果通知
    const notes = await ds.manager.find(Notification, { where: { companyId: admin.companyId, userId: ops.id } });
    expect(notes.some((n) => n.title.includes('SKU 申请已通过'))).toBe(true);
    // 完成后的预览显示已生成的编码
    const after = await sku.preview(ops, run.id);
    expect(after.specs[0].created).toHaveLength(2);
    ids.doneRun = run.id;
  });

  it('没有同步权限不能勾选加入同步队列；没勾选就不入队', async () => {
    const run = await toReview([spec('丙', ids.pearBc)]);
    const noSync = au(fin.id, fin.companyId, '财务', ['resource.finance-bundles.create', 'resource.finance-bundles.edit']);
    await expect(finPass(noSync, run, { confirmed: true, syncToJst: true })).rejects.toThrow(/同步的权限/);
    const before = (await ds.query("SELECT COUNT(*) AS n FROM outbox_jobs WHERE company_id = ?", [admin.companyId]))[0].n;
    const done = await finPass(noSync, run, { confirmed: true });
    expect(done.status).toBe('completed');
    expect((await ds.query("SELECT COUNT(*) AS n FROM outbox_jobs WHERE company_id = ?", [admin.companyId]))[0].n).toBe(before);
  });

  it('财务办理人没有「商品组合编码」的新增修改权限：整个审核失败、什么都不生成', async () => {
    const run = await toReview([spec('丁', ids.appleBc, { gift: [{ baseCodeId: ids.giftBc, qty: 1 }] })]);
    const weak = au(fin.id, fin.companyId, '财务', []);
    await expect(finPass(weak, run)).rejects.toThrow(/商品组合编码/);
    const n = await ds.manager.count(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-bundles' } });
    expect(n).toBe(6); // 之前两张申请共生成 4 + 2
    await flow.stop(fin, run.id, 'reject', { revision: run.revision, stepId: run.activeStep!.id, reason: '不做了' });
    expect((await flow.detail(admin, run.id)).status).toBe('rejected');
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-bundles' } })).toBe(6);
  });

  it('已有相同构成的组合编码：必须写原因才能申请，通过后沿用已有编码，不重复新建', async () => {
    await expect(flow.start(ops, 'sku-batch-apply', payload([spec('重复', ids.appleBc)]))).rejects.toThrow(/已经有主商品、赠品相同/);
    const run = await toWarehouse([spec('重复', ids.appleBc, { reuseReason: '换了新的包装方案，需要单独核算' })]);
    // 构成相同但仓库配置和前一张不同（前一张有包装/标签/人工）→ 仓库配置一致时才会沿用
    const rv = await whPass(wh, run, [whLines()]);
    const done = await finPass(fin, rv);
    expect(done.status).toBe('completed');
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-bundles' } })).toBe(6); // 没有新增
  });

  it('被退回与重新提交：仓库退回给运营修改，运营重新提交后再走一遍；财务退回仓库重做', async () => {
    const run = await toWarehouse([spec('退回', ids.mangoBc, { gift: [{ baseCodeId: ids.giftBc, qty: 2 }] })]);
    const back = await flow.returnBack(wh, run.id, { revision: run.revision, stepId: run.activeStep!.id, reason: '赠品数量不对' });
    expect(back.activeStep!.type).toBe('submit');
    expect(back.me.canResubmit).toBe(false); // 仓库自己看不到重提入口
    const mine = await flow.detail(ops, run.id);
    expect(mine.me.canResubmit).toBe(true);
    await expect(flow.resubmit(wh, run.id, { revision: mine.revision, payload: payload([spec('退回', ids.mangoBc)]) })).rejects.toThrow(/只有发起人/);
    // 重新提交不会和自己在办的那张冲突
    const again = await flow.resubmit(ops, run.id, { revision: mine.revision, payload: payload([spec('退回', ids.mangoBc, { gift: [{ baseCodeId: ids.giftBc, qty: 1 }] })]) });
    expect(again.activeStep!.key).toBe('warehouse');
    const rv = await whPass(wh, again, [whLines()]);
    const ret = await flow.returnBack(fin, rv.id, { revision: rv.revision, stepId: rv.activeStep!.id, reason: '人工要换' });
    expect(ret.activeStep!.key).toBe('warehouse');
    const rv2 = await whPass(wh, ret, [whLines({ lines: [{ role: 'package', baseCodeId: ids.boxBc, qty: 1 }, { role: 'label', baseCodeId: ids.labelBc, qty: 1 }], notRequired: { other: '无', labor: '无需人工' } })]);
    const done = await finPass(fin, rv2);
    expect(done.status).toBe('completed');
    const made = (await ds.manager.find(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-bundles' } })).filter((b) => b.data.sourceRunId === run.id);
    expect(made).toHaveLength(2);
    const myLines = (await ds.manager.find(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-bundle-lines' } })).filter((l) => made.some((b) => b.id === l.data.bundleId));
    expect(myLines.some((l) => l.data.role === 'labor')).toBe(false); // 退回重做后不再有人工行
    expect(myLines.some((l) => l.data.role === 'package')).toBe(true);
  });

  it('仓库提交之后商品成本变了：财务不能直接通过，必须退回仓库重新确认', async () => {
    const run = await toReview([spec('漂移', ids.pearBc, { gift: [{ baseCodeId: ids.giftBc, qty: 3 }] })]);
    const prod = await ds.manager.findOneOrFail(ResourceRecord, { where: { id: ids.giftBc } });
    await resources.update(admin, 'finance-products', Number(prod.data.productId), { purchasePrice: 555 });
    await resources.changeStatus(admin, 'finance-base-codes', ids.giftBc, 'verified');
    await expect(finPass(fin, await flow.detail(fin, run.id))).rejects.toThrow(/发生了变化|退回仓库/);
    const cur = await flow.detail(fin, run.id);
    const back = await flow.returnBack(fin, run.id, { revision: cur.revision, stepId: cur.activeStep!.id, reason: '成本变了' });
    const rv = await whPass(wh, back, [whLines()]);
    expect((await finPass(fin, rv)).status).toBe('completed');
  });

  it('在办的申请里已经有同样构成：不能再申请一遍', async () => {
    const mango3 = { name: '芒果三', main: [{ baseCodeId: ids.mangoBc, qty: 3 }], gift: [] };
    const run = await toWarehouse([mango3]);
    await expect(flow.start(ops, 'sku-batch-apply', payload([{ ...mango3, name: '另一个名字' }]))).rejects.toThrow(/重复/);
    await flow.withdraw(ops, run.id, { revision: run.revision });
    // 撤回后可以再申请
    const again = await flow.start(ops, 'sku-batch-apply', payload([mango3]), key());
    expect(again.status).toBe('running');
    await flow.withdraw(ops, again.id, { revision: again.revision });
  });

  it('生成过程中任何一步失败：整个审核回滚，已建好的组合和验证都不留，申请仍停在财务审核', async () => {
    const run = await toReview([spec('回滚甲', ids.pearBc, { gift: [{ baseCodeId: ids.giftBc, qty: 7 }] }), spec('回滚乙', ids.mangoBc, { gift: [{ baseCodeId: ids.giftBc, qty: 7 }] })]);
    const before = await ds.manager.count(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-bundles' } });
    const real = resources.setStatusChecked.bind(resources);
    let calls = 0;
    const spy = jest.spyOn(resources, 'setStatusChecked').mockImplementation(async (...a: Parameters<typeof real>) => {
      if (++calls === 3) throw new Error('模拟验证失败');
      return real(...a);
    });
    try {
      await expect(finPass(fin, run)).rejects.toThrow(/模拟验证失败/);
    } finally { spy.mockRestore(); }
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: admin.companyId, type: 'finance-bundles' } })).toBe(before);
    const cur = await flow.detail(fin, run.id);
    expect(cur.status).toBe('running');
    expect(cur.activeStep!.key).toBe('review');
    expect((await finPass(fin, cur)).status).toBe('completed'); // 恢复后可以正常通过
  });

  it('申请选项接口不需要财务资料权限，也不带成本；预览只对相关的人开放', async () => {
    const meta = await sku.options(ops, 'meta');
    expect(meta.platforms!.map((p) => p.name)).toEqual(expect.arrayContaining(['淘宝', '抖音']));
    const mains = await sku.options(ops, 'main', '苹果');
    expect(mains.items!.map((i) => i.code)).toEqual(['APPLE-A']);
    expect(JSON.stringify(mains)).not.toMatch(/cost|price/i);
    expect((await sku.options(ops, 'package')).items!.map((i) => i.code)).toEqual(['BOX-A']);
    expect((await sku.options(ops, 'labor')).items![0].name).toBe('装箱');
    // 别家公司看不到：换一个公司的用户
    const other = await ds.manager.save(Company, ds.manager.create(Company, { code: `o${crypto.randomBytes(5).toString('hex')}`, name: '别家', status: 'active' }));
    const ou = au(await mkUser(other.id, 'x', '外人'), other.id, '外人', ['flow.apply.view']);
    expect((await sku.options(ou, 'main')).items).toEqual([]);
    await expect(sku.preview(ou, ids.doneRun)).rejects.toThrow(/不存在/);
  });
});
