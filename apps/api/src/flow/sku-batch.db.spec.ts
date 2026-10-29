/** SKU 申请汇总：汇总待办、批量办理、整单退回、个别规格退回并重新提交。RESOURCE_DB_TEST=1 TEST_DB_NAME=xxx npx jest --runInBand sku-batch */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import type { StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Notification, ResourceRecord, User } from '../entities';
import { FeishuNoticeService } from '../outbox/feishu-notice.service';
import { OutboxService } from '../outbox/outbox.service';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { FlowService } from './flow.service';
import { SkuApplyService } from './sku-apply.service';
import { SkuBatchService } from './sku-batch.service';
import { AuditLog } from '../entities';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('SKU 申请汇总（真实数据库）', () => {
  let ds: DataSource;
  let flow: FlowService;
  let sku: SkuApplyService;
  let batch: SkuBatchService;
  let feishu: FeishuNoticeService;
  let resources: ReturnType<typeof buildServices>['resources'];
  let wh2: AuthUser;
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
    feishu = new FeishuNoticeService(ds);
    flow = new FlowService(ds, resources, new FinanceDocumentsService(ds), bundles, outbox, feishu);
    sku = new SkuApplyService(ds, flow, bundles);
    batch = new SkuBatchService(ds, flow, bundles);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `k${crypto.randomBytes(5).toString('hex')}`, name: 'SKU申请测试', status: 'active' }));
    admin = { id: await mkUser(c.id, 'admin', '管理员', { isCompanyAdmin: true }), companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    ops = au(await mkUser(c.id, 'ops', '运营'), c.id, '运营', ['flow.apply.view']);
    wh = au(await mkUser(c.id, 'wh', '仓库'), c.id, '仓库');
    wh2 = au(await mkUser(c.id, 'wh2', '仓库二'), c.id, '仓库二');
    fin = au(await mkUser(c.id, 'fin', '财务'), c.id, '财务', ['resource.finance-bundles.create', 'resource.finance-bundles.edit', 'finance.jst-sync.view', 'finance.bundle-sync.manage', 'product.cost.view']);
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
  const qspec = (name: string, main: number, qty: number) => ({ name, main: [{ baseCodeId: main, qty }], gift: [] });
  let seq = 100;
  const nextQty = () => (seq += 1);
  const split = async (n: number) => {
    const specs = Array.from({ length: n }, (_, i) => qspec(`批${seq}-${i + 1}`, ids.pearBc, nextQty()));
    const out = await sku.startSplit(ops, payload(specs), key());
    return out;
  };
  const rev = async (id: number) => {
    const r = await flow.detail(admin, id);
    return { runId: id, revision: r.revision, stepId: r.activeStep?.id };
  };
  const auditCount = async (action: string) =>
    (await ds.manager.count(AuditLog, { where: { companyId: admin.companyId, action } }));

  it('汇总待办：同一张申请单的多个规格在办理人待办里只占一行，带规格数；汇总看板列出每个规格', async () => {
    const out = await split(3);
    const todos = await flow.todos(wh, { tab: 'pending', page: 1, pageSize: 50 });
    const rows = todos.rows.filter((x: { batchKey?: string }) => x.batchKey === out.batchKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].batchCount).toBe(3);
    const board = await batch.board(wh, out.batchKey);
    expect(board.total).toBe(3);
    expect(board.me).toMatchObject({ holdStepKey: 'warehouse', holdCount: 3, canReturnAll: true });
    expect(board.items.every((i) => i.mine)).toBe(true);
    // 路人看不到
    await expect(batch.board(noApply, out.batchKey)).rejects.toThrow(/不存在|权限/);
    await expect(batch.board(wh, 'bad ref!')).rejects.toThrow(/编号/);
    for (const r of out.runs) await flow.withdraw(ops, r.id, { revision: (await rev(r.id)).revision });
  });

  it('批量通过：仓库一次把选中的规格提交财务（套用同一份发货组成），财务再批量通过；汇总通知不逐条刷屏', async () => {
    const out = await split(3);
    const before = await ds.manager.count(Notification, { where: { companyId: admin.companyId, userId: fin.id } });
    const items = await Promise.all(out.runs.map((r) => rev(r.id)));
    const res = await batch.act(wh, { ref: out.batchKey, action: 'pass', items, form: { config: [whLines()] } });
    expect(res).toMatchObject({ ok: 3, failed: 0 });
    const after = await ds.manager.count(Notification, { where: { companyId: admin.companyId, userId: fin.id } });
    expect(after - before).toBe(1);
    expect(await auditCount('flow.sku.batch.pass')).toBeGreaterThanOrEqual(1);
    const todos = await flow.todos(fin, { tab: 'pending', page: 1, pageSize: 50 });
    expect(todos.rows.filter((x: { batchKey?: string }) => x.batchKey === out.batchKey)).toHaveLength(1);
    const fItems = await Promise.all(out.runs.map((r) => rev(r.id)));
    const fres = await batch.act(fin, { ref: out.batchKey, action: 'pass', items: fItems, form: { confirmed: true } });
    expect(fres.ok).toBe(3);
    const b = await batch.board(ops, out.batchKey);
    expect(b.counts.completed).toBe(3);
    expect(b.history.length).toBeGreaterThan(0);
  });

  it('批量办理：部分成功。别人的待办、版本号过期的规格单独报失败，其余照常办；没选或超过 100 个被拒', async () => {
    const out = await split(3);
    const items = await Promise.all(out.runs.map((r) => rev(r.id)));
    items[2].revision -= 1; // 过期
    const res = await batch.act(wh, { ref: out.batchKey, action: 'pass', items, form: { config: [whLines()] } });
    expect(res.ok).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.results.find((r) => !r.ok)!.runId).toBe(items[2].runId);
    // 不是办理人
    const none = await batch.act(wh2, { ref: out.batchKey, action: 'pass', items: [await rev(out.runs[2].id)], form: { config: [whLines()] } }).catch((e: Error) => e);
    expect(none instanceof Error ? none.message : none.failed).toBeTruthy();
    await expect(batch.act(wh, { ref: out.batchKey, action: 'pass', items: [] })).rejects.toThrow(/1 到 100/);
    await expect(batch.act(wh, { ref: out.batchKey, action: 'pass', items: [items[0], items[0]] })).rejects.toThrow(/重复/);
    const fItems = await Promise.all(out.runs.map((r) => rev(r.id)));
    await batch.act(fin, { ref: out.batchKey, action: 'cancel', items: fItems.filter((x) => x.stepId), comment: '清理' }).catch(() => undefined);
  });

  it('批量退回：原因必填；退回的规格回到申请人，申请人收到一条汇总通知，且带原因', async () => {
    const out = await split(3);
    const items = await Promise.all(out.runs.map((r) => rev(r.id)));
    await expect(batch.act(wh, { ref: out.batchKey, action: 'return', items })).rejects.toThrow(/原因/);
    const before = await ds.manager.count(Notification, { where: { companyId: admin.companyId, userId: ops.id, kind: 'returned' } });
    const res = await batch.act(wh, { ref: out.batchKey, action: 'return', items: items.slice(0, 2), comment: '赠品不对' });
    expect(res.ok).toBe(2);
    const after = await ds.manager.find(Notification, { where: { companyId: admin.companyId, userId: ops.id, kind: 'returned' }, order: { id: 'DESC' } });
    expect(after.length - before).toBe(1);
    expect(after[0].body).toContain('赠品不对');
    const board = await batch.board(ops, out.batchKey);
    expect(board.counts.returned).toBe(2);
    const ret = board.items.filter((i) => i.enteredVia === 'return');
    expect(ret.every((i) => i.returnReason === '赠品不对' && i.canResubmit)).toBe(true);
    // 申请人原样重新提交：回到仓库，批次标记保留
    const re = await batch.act(ops, { ref: out.batchKey, action: 'resubmit', items: await Promise.all(ret.map((i) => rev(i.runId as number))) });
    expect(re.ok).toBe(2);
    const again = await batch.board(wh, out.batchKey);
    expect(again.me.holdCount).toBe(3);
    expect(await auditCount('flow.sku.batch.return')).toBeGreaterThanOrEqual(1);
    for (const r of out.runs) await flow.withdraw(ops, r.id, { revision: (await rev(r.id)).revision });
  });

  it('整单退回：必须全是自己的待办、原因必填、版本过期整体失败；成功则全部规格同时退回', async () => {
    const out = await split(3);
    const items = await Promise.all(out.runs.map((r) => rev(r.id)));
    await expect(batch.returnAll(wh, { ref: out.batchKey, items, reason: '' })).rejects.toThrow(/原因/);
    // 版本过期：什么都不退
    await expect(batch.returnAll(wh, { ref: out.batchKey, items: items.map((x, i) => (i === 0 ? { ...x, revision: x.revision - 1 } : x)), reason: '不对' })).rejects.toThrow(/变化/);
    expect((await batch.board(wh, out.batchKey)).counts.returned).toBe(0);
    // 另一个仓库的人手里没有这些规格
    await expect(batch.returnAll(wh2, { ref: out.batchKey, items, reason: '不对' })).rejects.toThrow();
    const ok = await batch.returnAll(wh, { ref: out.batchKey, items, reason: '整单资料有误' });
    expect(ok.count).toBe(3);
    const board = await batch.board(ops, out.batchKey);
    expect(board.counts.returned).toBe(3);
    expect(await auditCount('flow.sku.return-all')).toBeGreaterThanOrEqual(1);
    for (const r of out.runs) await flow.withdraw(ops, r.id, { revision: (await rev(r.id)).revision });
  });

  it('个别规格退回（没拆开的一张申请）：被退回的拆出成新流程回到申请人，其余规格留在仓库继续办理', async () => {
    const run = await toWarehouse([qspec('留一', ids.pearBc, nextQty()), qspec('退二', ids.pearBc, nextQty()), qspec('留三', ids.pearBc, nextQty())]);
    const st = run.activeStep!;
    await expect(batch.returnSpecs(wh, { runId: run.id, revision: run.revision, stepId: st.id, specs: ['退二'], reason: '' })).rejects.toThrow(/原因/);
    await expect(batch.returnSpecs(wh, { runId: run.id, revision: run.revision, stepId: st.id, specs: ['没有'], reason: '错' })).rejects.toThrow(/没有规格/);
    await expect(batch.returnSpecs(stranger, { runId: run.id, revision: run.revision, stepId: st.id, specs: ['退二'], reason: '错' })).rejects.toThrow();
    const out = await batch.returnSpecs(wh, { runId: run.id, revision: run.revision, stepId: st.id, specs: ['退二'], reason: '规格二的包装不对' });
    expect(out.split).toBe(true);
    const rest = await flow.detail(admin, run.id);
    expect((rest.payload.specs as { name: string }[]).map((s) => s.name)).toEqual(['留一', '留三']);
    expect(rest.activeStep!.key).toBe('warehouse');
    const carved = await flow.detail(admin, out.newRunId);
    expect((carved.payload.specs as { name: string }[]).map((s) => s.name)).toEqual(['退二']);
    expect(carved.activeStep!.key).toBe('apply');
    // 剩下的继续走完（仓库 → 财务）
    const rv = await whPass(wh, rest as never, [whLines(), whLines()]);
    const done = await finPass(fin, rv);
    expect(done.status).toBe('completed');
    // 退回的那条申请人改好重新提交
    const re = await flow.resubmit(ops, carved.id, { revision: carved.revision, payload: Object.fromEntries(Object.entries(carved.payload).filter(([k]) => !k.startsWith('_'))) });
    expect(re.activeStep!.key).toBe('warehouse');
    const keyRow = await ds.query("SELECT JSON_UNQUOTE(JSON_EXTRACT(payload, '$._batchKey')) AS k FROM flow_runs WHERE id IN (?, ?)", [rest.id, re.id]);
    expect(keyRow.map((x: { k: string }) => x.k)).toEqual([out.ref, out.ref]);
    expect(await auditCount('flow.sku.return-specs')).toBeGreaterThanOrEqual(1);
    const board = await batch.board(ops, out.ref);
    expect(board.runCount).toBe(2);
    await flow.withdraw(ops, re.id, { revision: re.revision });
  });

  it('个别规格退回：全选等于整条退回（不拆）', async () => {
    const run = await toWarehouse([qspec('全一', ids.pearBc, nextQty()), qspec('全二', ids.pearBc, nextQty())]);
    const out = await batch.returnSpecs(wh, { runId: run.id, revision: run.revision, stepId: run.activeStep!.id, specs: ['全一', '全二'], reason: '整体不对' });
    expect(out.split).toBe(false);
    expect((await flow.detail(admin, run.id)).activeStep!.key).toBe('apply');
    await flow.withdraw(ops, run.id, { revision: (await flow.detail(admin, run.id)).revision });
  });

});
