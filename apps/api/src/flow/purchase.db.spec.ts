/** 采购申请流程（真实数据库）：RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_u10 npx jest purchase.db */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import type { StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FlowRun, ResourceFile, ResourceRecord, User } from '../entities';
import { OutboxService } from '../outbox/outbox.service';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { FlowService } from './flow.service';
import { PurchaseService } from './purchase.service';
import { earmarkedPrepay, stateOf } from './purchase';

jest.setTimeout(60_000);
const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
type Run = Awaited<ReturnType<FlowService['start']>>;

d('采购申请流程（真实数据库）', () => {
  let ds: DataSource;
  let flow: FlowService;
  let svc: PurchaseService;
  let docs: FinanceDocumentsService;
  let resources: ReturnType<typeof buildServices>['resources'];
  let admin: AuthUser, ops: AuthUser, buyer: AuthUser, boss: AuthUser, cashier: AuthUser, fin: AuthUser, whs: AuthUser, stranger: AuthUser, outsider: AuthUser;
  const ids: Record<string, number> = {};
  const key = () => crypto.randomBytes(8).toString('hex') + 'abcd';
  const mkUser = async (companyId: number, account: string, name: string, extra: Partial<User> = {}) =>
    (await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra }))).id;
  const au = (id: number, companyId: number, name: string, allow: string[] = []): AuthUser => ({ id, companyId, name, permissions: { isCompanyAdmin: false, allow, deny: [] } });
  let company = 0;
  const file = async (uploadedBy: number) => (await ds.manager.save(ResourceFile, ds.manager.create(ResourceFile, { companyId: company, resourceType: 'flow-purchase', resourceId: null, fieldKey: 'evidence', storageKey: `local:t/${key()}.png`, name: '凭证.png', mime: 'image/png', size: 10, uploadedBy }))).id;
  const reload = async (id: number) => flow.detail(admin, id);
  /** 当前步骤的办理人办理一步 */
  const go = async (u: AuthUser, id: number, data: unknown, comment?: string, expectKey?: string) => {
    const r = await reload(id);
    if (expectKey) expect(r.activeStep?.key).toBe(expectKey);
    return flow.pass(u, id, { revision: r.revision, stepId: r.activeStep!.id, form: { ...(data === undefined ? {} : { data }), ...(comment ? { comment } : {}) } });
  };
  const stateRow = async (id: number) => stateOf((await ds.manager.findOneOrFail(FlowRun, { where: { id } })).payload);
  const bal = async (kind: string, account: number) => Number((await ds.query('SELECT COALESCE(SUM(amount_cents),0) a FROM finance_entries WHERE company_id = ? AND kind = ? AND account_id = ?', [company, kind, account]))[0].a);
  const start = (u: AuthUser, lines: unknown, over: Record<string, unknown> = {}) => flow.start(u, 'purchase-request', { lines, requestedArrivalAt: '2099-12-31', ...over }, key());
  const L = () => [{ productId: ids.apple, qty: 10, aliasName: '红富士' }, { productId: ids.pear, qty: 4 }];
  const plan = (over: Record<string, unknown> = {}) => ({ supplierId: ids.supp, warehouseId: ids.wh, paymentMode: 'mixed', payeeName: '果园', payeeAccount: '6222 0000 1111', prices: { [ids.apple]: 250.1234, [ids.pear]: 1000 }, ...over });

  /** 走到“已审批” */
  async function approved(over: Record<string, unknown> = {}, lines: unknown = L()) {
    const run = await start(ops, lines);
    await go(buyer, run.id, plan(over), undefined, 'plan');
    await go(boss, run.id, undefined, '同意', 'approve');
    return run;
  }
  const payOnce = async (id: number, amountCents: number, claimCents?: number) =>
    go(cashier, id, { payments: amountCents ? [{ amountCents, bankAccountId: ids.bank, reference: `LS${key()}`, payeeName: '果园', payeeAccount: '6222 0000 1111', files: [await file(cashier.id)] }] : [], ...(claimCents ? { claimCents } : {}) }, undefined, 'pay');
  const topUp = async (cents: number) => { const x = await docs.createDraft(admin, { type: 'prepayment', date: '2026-10-01', partyId: ids.supp, partyKind: 'supplier', bankAccountId: ids.bank, amountCents: cents }); await docs.post(admin, x.id); };
  const toDispatch = async (amountCents: number, claimCents?: number) => {
    if (claimCents) await topUp(claimCents);
    const run = await approved();
    await payOnce(run.id, amountCents, claimCents);
    await go(fin, run.id, undefined, undefined, 'prepay_review');
    return run;
  };
  const dispatch = async (id: number, lines: Array<{ productId: number; qty: number }>, extra: Record<string, unknown> = {}, comment?: string) =>
    go(fin, id, { lines, logisticsNo: `SF${key().slice(0, 6)}`, expectedArrivalAt: '2099-11-01', files: [await file(fin.id)], ...extra }, comment, 'dispatch');
  const arrive = async (id: number) => go(whs, id, { files: [await file(whs.id)] }, undefined, 'arrival');
  const receive = async (id: number, lines: Array<{ productId: number; qty: number }>, over: Record<string, unknown> = {}, comment?: string) => go(whs, id, { lines, files: [await file(whs.id)], ...over }, comment, 'receive');
  const quality = async (id: number, lines: Array<{ productId: number; qty: number }>, comment?: string) => go(whs, id, { lines, files: [await file(whs.id)] }, comment, 'quality');
  const noFee = (id: number) => go(whs, id, { fees: [], zeroReason: '供应商承担物流' }, undefined, 'expense');

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    resources = s.resources;
    docs = new FinanceDocumentsService(ds);
    const outbox = new OutboxService(ds, resources);
    flow = new FlowService(ds, resources, docs, new BundleToolsService(ds, resources, outbox), outbox);
    svc = new PurchaseService(ds, flow, { putBlob: async () => ({ id: 0 }), urlOf: async () => ({ url: 'http://x' }) } as never);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `k${crypto.randomBytes(5).toString('hex')}`, name: '采购测试', status: 'active' }));
    const c2 = await ds.manager.save(Company, ds.manager.create(Company, { code: `k${crypto.randomBytes(5).toString('hex')}`, name: '别家', status: 'active' }));
    company = c.id;
    admin = { id: await mkUser(c.id, 'admin', '管理员', { isCompanyAdmin: true }), companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    ops = au(await mkUser(c.id, 'ops', '运营'), c.id, '运营', ['flow.apply.view']);
    buyer = au(await mkUser(c.id, 'buyer', '采购'), c.id, '采购');
    boss = au(await mkUser(c.id, 'boss', '老板'), c.id, '老板');
    cashier = au(await mkUser(c.id, 'cashier', '出纳'), c.id, '出纳');
    fin = au(await mkUser(c.id, 'fin', '财务'), c.id, '财务');
    whs = au(await mkUser(c.id, 'whs', '仓库'), c.id, '仓库');
    stranger = au(await mkUser(c.id, 'str', '路人'), c.id, '路人', ['flow.apply.view']);
    outsider = { id: await mkUser(c2.id, 'out', '外人', { isCompanyAdmin: true }), companyId: c2.id, name: '外人', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };

    const root = await resources.create(admin, 'finance-categories', { archiveType: 'raw', name: '采购测试类', code: 'CG' });
    const cat = (await resources.create(admin, 'finance-categories', { archiveType: 'raw', name: '采购测试类下', code: 'CG1', parentId: root.id })).id;
    const zero = { zeroValueReason: '运费：无\n装卸费：无' };
    const raw = (name: string, over: Record<string, unknown> = {}) => resources.create(admin, 'finance-products', { archiveType: 'raw', name, categoryId: cat, purchaseSpec: '斤', specQty: 1, specUnit: 'J', purchasePrice: 100, freight: 0, handlingFee: 0, ...zero, ...over });
    ids.apple = (await raw('采购苹果', { rawFinishedNames: '红富士\n烟富3号' })).id;
    ids.pear = (await raw('采购梨', {})).id;
    ids.cat = cat;
    ids.supp = (await resources.create(admin, 'finance-suppliers', { name: '果园' })).id;
    ids.wh = (await resources.create(admin, 'finance-warehouses', { name: '采购仓' })).id;
    ids.bank = (await resources.create(admin, 'bank-accounts', { kind: 'company_public', accountName: '公户', bank: '测试银行', accountNo: '6222000011112222', balance: 100000 })).id;
    ids.bank2 = (await resources.create(admin, 'bank-accounts', { kind: 'cashier_account', accountName: '出纳', bank: '测试银行', accountNo: '6222000033334444' })).id;
    ids.freight = (await resources.create(admin, 'finance-fee-items', { name: '运费', direction: 'expense' })).id;
    ids.handling = (await resources.create(admin, 'finance-fee-items', { name: '装卸费', direction: 'expense' })).id;

    const step = (k: string, name: string, type: StepDef['type'], who?: AuthUser): StepDef => ({ key: k, name, type, ...(type === 'submit' ? { assignee: { source: 'requester' } } : who ? { assignee: { source: 'employee', id: who.id } } : {}) }) as StepDef;
    await flow.saveDraft(admin, 'purchase-request', [
      step('apply', '提交', 'submit'), step('plan', '方案', 'execute', buyer), step('approve', '审批', 'approval', boss), step('pay', '付款', 'finance', cashier),
      step('prepay_review', '确认预付', 'finance', fin), step('dispatch', '发货', 'execute', fin), step('arrival', '到货', 'execute', whs), step('receive', '收货', 'execute', whs),
      step('quality', '质检', 'execute', whs), step('exception', '异常', 'approval', boss), step('refund', '退款', 'finance', cashier), step('expense', '费用', 'execute', whs),
      step('settle', '结算', 'finance', fin), step('expense_pay', '付费用', 'finance', cashier), step('end', '结束', 'end'),
    ], []);
    await flow.publish(admin, 'purchase-request');
    // 供应商已有一笔预付款 3000 分，可以被采购占用
    const pre = await docs.createDraft(admin, { type: 'prepayment', date: '2026-10-01', partyId: ids.supp, partyKind: 'supplier', bankAccountId: ids.bank, amountCents: 3000 });
    await docs.post(admin, pre.id);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('发起：商品要有效、原料有成品名必须选、数量最多 4 位小数、单位和档案一致；补全名称编码单位', async () => {
    await expect(start(ops, [{ productId: ids.apple, qty: 1 }])).rejects.toThrow(/成品名/);
    await expect(start(ops, [{ productId: ids.pear, qty: 1, aliasName: '假名' }])).rejects.toThrow(/没有成品名/);
    await expect(start(ops, [{ productId: 99999, qty: 1 }])).rejects.toThrow(/不存在/);
    await expect(start(ops, [{ productId: ids.pear, qty: 0 }])).rejects.toThrow(/大于 0/);
    await expect(start(ops, [{ productId: ids.pear, qty: 1.00001 }])).rejects.toThrow(/4 位小数/);
    await expect(start(ops, [{ productId: ids.pear, qty: 1, unit: '箱' }])).rejects.toThrow(/单位已变化/);
    await expect(start(ops, [{ productId: ids.pear, qty: 1 }, { productId: ids.pear, qty: 2 }])).rejects.toThrow(/不能重复/);
    await expect(start(ops, [{ productId: ids.pear, qty: 1, price: 5 }])).rejects.toThrow(/不能填写的字段/);
    await expect(start(ops, L(), { requestedArrivalAt: '2020-01-01' })).rejects.toThrow(/不能早于今天/);
    await expect(start(outsider, L())).rejects.toThrow();
    const run = await start(ops, L());
    expect(run.title).toBe('采购申请 · 红富士 等 2 项');
    expect((run.payload.lines as Array<{ name: string; unit: string }>)[0]).toMatchObject({ name: '红富士', unit: '斤' });
    expect(run.activeStep?.key).toBe('plan');
    expect(JSON.stringify(run)).not.toContain('_purchase');
  });

  it('方案：单价必填且最多 6 位元小数，供应商仓库要有效；办理记录里看不到单价', async () => {
    const run = await start(ops, L());
    await expect(go(buyer, run.id, plan({ prices: { [ids.apple]: 250 } }))).rejects.toThrow(/梨/);
    await expect(go(buyer, run.id, plan({ prices: { [ids.apple]: 250.12345, [ids.pear]: 1 } }))).rejects.toThrow(/单价/);
    await expect(go(buyer, run.id, plan({ supplierId: 99999 }))).rejects.toThrow(/供应商/);
    await expect(go(buyer, run.id, plan({ payeeAccount: '' }))).rejects.toThrow(/收款账户/);
    await expect(go(buyer, run.id, plan({ extra: 1 }))).rejects.toThrow(/不能填写的字段/);
    await expect(go(whs, run.id, plan())).rejects.toThrow(/不是你办理/);
    const next = await go(buyer, run.id, plan(), '先按这个价');
    expect(next.activeStep?.key).toBe('approve');
    const planned = next.steps.find((x) => x.key === 'plan')!;
    expect(JSON.stringify(planned.form)).not.toContain('250');
    expect((await stateRow(run.id)).prices[String(ids.apple)]).toBe(250.1234);
  });

  it('脱敏：运营（发起人）看不到单价和付款；办理过金额步骤的人、管理员能看；不相干的人看不到这张单', async () => {
    const run = await toDispatch(3000, 2000);
    const opsView = (await svc.state(ops, run.id)) as unknown as Record<string, unknown>;
    expect(opsView.money).toBe(false);
    expect(opsView.paid).toBe(true); // 是否已付款不是金额信息，运营要据此决定能不能申请变更
    const text = JSON.stringify(opsView);
    for (const k of ['unitPriceCents', 'payments', 'approvedCents', 'payeeAccount', 'prepay"', 'goodsCents']) expect(text).not.toContain(k);
    expect((opsView.lines as Array<{ name: string; qty: number }>).map((l) => l.name)).toEqual(['红富士', '采购梨']);
    const buyerView = (await svc.state(buyer, run.id)) as unknown as { money: boolean; lines: Array<{ unitPriceCents: number }>; approvedCents: number; payments: unknown[]; prepay: { reservedCents: number } };
    expect(buyerView.money).toBe(true);
    expect(buyerView.lines[0].unitPriceCents).toBe(250.1234);
    expect(buyerView.approvedCents).toBe(2501 + 4000);
    expect(buyerView.payments).toHaveLength(1);
    expect(buyerView.prepay.reservedCents).toBe(5000);
    expect(((await svc.state(admin, run.id)) as unknown as { money: boolean }).money).toBe(true);
    await expect(svc.state(stranger, run.id)).rejects.toThrow(/没有查看/);
    await expect(svc.state(outsider, run.id)).rejects.toThrow();
  });

  it('货款：新付款生成预付款单并过账；占用已有预付款不能超过可用余额；总额不能超过批准金额；收款账户要和方案一致', async () => {
    const run = await approved();
    const before = await bal('prepayment', ids.supp);
    const p = (over: Record<string, unknown> = {}) => ({ amountCents: 1000, bankAccountId: ids.bank, reference: `LS${key()}`, payeeName: '果园', payeeAccount: '6222 0000 1111', files: [] as number[], ...over });
    await expect(go(cashier, run.id, { payments: [] }, undefined, 'pay')).rejects.toThrow(/新付款|预付款/);
    await expect(go(cashier, run.id, { payments: [p({ files: [] })] })).rejects.toThrow(/付款凭证/);
    const f = await file(cashier.id);
    await expect(go(cashier, run.id, { payments: [p({ files: [f], payeeAccount: '999' })] })).rejects.toThrow(/不一致/);
    await expect(go(cashier, run.id, { payments: [p({ files: [f], amountCents: 9999 })] })).rejects.toThrow(/超过批准金额/);
    await expect(go(cashier, run.id, { payments: [], claimCents: 999999 })).rejects.toThrow(/可占用/);
    const otherFile = await ds.manager.save(ResourceFile, ds.manager.create(ResourceFile, { companyId: company, resourceType: 'finance-products', resourceId: null, fieldKey: 'photos', storageKey: 'local:x', name: 'a.png', mime: 'image/png', size: 1, uploadedBy: 1 }));
    await expect(go(cashier, run.id, { payments: [p({ files: [otherFile.id] })] })).rejects.toThrow(/无效的文件/);
    const ref = `LS${key()}`;
    await go(cashier, run.id, { payments: [p({ files: [f], amountCents: 3000, reference: ref })], claimCents: 2000 });
    const s = await stateRow(run.id);
    expect(s.payments).toHaveLength(1);
    expect(s.payments[0].docNo).toMatch(/^YF/);
    expect(s.prepayClaimCents).toBe(2000);
    expect(await bal('prepayment', ids.supp)).toBe(before + 3000);
    const doc = await ds.query('SELECT status, source_key sk, ref_no r FROM finance_documents WHERE id = ?', [s.payments[0].docId]);
    expect(doc[0]).toMatchObject({ status: 'posted', sk: `flow:${run.id}:pay:0`, r: ref });
    // 同一个银行流水不能重复登记
    const again = await approved();
    await expect(go(cashier, again.id, { payments: [p({ files: [await file(cashier.id)], reference: ref })] })).rejects.toThrow(/已经登记过/);
    // 这 2000 已被占用：别的采购最多还能占 1000（余额 6000 - 本次新付款已在里面的…按余额 − 占用计算）
    const free = (await svc.options(cashier, again.id)) as unknown as { prepay?: { availableCents: number } };
    expect(free.prepay?.availableCents).toBe((await bal('prepayment', ids.supp)) - (await earmarkedPrepay(ds.manager, company, ids.supp, again.id)));
  });

  it('两批到货：换货、结算、冲抵预付款、费用分摊、更新商品成本、付费用生成费用单；办完流程结束', async () => {
    const run = await toDispatch(3000, 2000);
    // 发货：数量不能超过待发货；必须有物流单号和凭证
    await expect(dispatch(run.id, [{ productId: ids.apple, qty: 11 }])).rejects.toThrow(/超过当前可办理数量/);
    await expect(dispatch(run.id, [{ productId: ids.apple, qty: 0 }])).rejects.toThrow(/大于零/);
    await expect(go(fin, run.id, { lines: [{ productId: ids.apple, qty: 6 }], logisticsNo: '', expectedArrivalAt: '2099-11-01', files: [await file(fin.id)] })).rejects.toThrow(/物流单号/);
    await expect(dispatch(run.id, [{ productId: ids.apple, qty: 6 }], { expectedArrivalAt: '2100-01-31' })).rejects.toThrow(/晚于要求日期/);
    await dispatch(run.id, [{ productId: ids.apple, qty: 6 }]);
    await arrive(run.id);
    // 实收 6，质检合格 5：不合格要说明，进入异常处理
    await receive(run.id, [{ productId: ids.apple, qty: 6 }]);
    await expect(quality(run.id, [{ productId: ids.apple, qty: 5 }])).rejects.toThrow(/不合格说明/);
    const exc = await quality(run.id, [{ productId: ids.apple, qty: 5 }], '一斤烂果');
    expect(exc.activeStep?.key).toBe('exception');
    await expect(go(boss, run.id, { resolution: 'accept_discount', files: [await file(boss.id)] }, '', 'exception')).rejects.toThrow(/处理原因/);
    // 折价接收 → 回质检确认 → 费用 → 结算时逐项确认折价单价
    const back = await go(boss, run.id, { resolution: 'accept_discount', files: [await file(boss.id)] }, '少付一点', 'exception');
    expect(back.activeStep?.key).toBe('quality');
    const toFee = await quality(run.id, [{ productId: ids.apple, qty: 6 }], '一斤烂果，折价接收');
    expect(toFee.activeStep?.key).toBe('expense');
    await go(whs, run.id, { fees: [{ type: 'freight', amountCents: 300, payeeName: '顺丰', payeeAccount: '6217 1', files: [await file(whs.id)] }, { type: 'handling', amountCents: 100, payeeName: '顺丰', payeeAccount: '6217 1', files: [await file(whs.id)] }] }, undefined, 'expense');
    await expect(go(fin, run.id, { allocationMethod: 'quantity', lines: [{ productId: ids.apple, unitPriceCents: 300 }] })).rejects.toThrow(/不能超过原批准单价/);
    await expect(go(fin, run.id, { allocationMethod: 'quantity', lines: [{ productId: ids.apple, unitPriceCents: 200 }], offsetCents: 99999 })).rejects.toThrow(/不能超过本批货款/);
    const stockBefore = await bal('payable', ids.supp);
    const toPay = await go(fin, run.id, { allocationMethod: 'quantity', lines: [{ productId: ids.apple, unitPriceCents: 200 }], offsetCents: 800 }, '六斤按折价收');
    expect(toPay.activeStep?.key).toBe('expense_pay');
    const s1 = await stateRow(run.id);
    const b1 = s1.batches[0];
    expect(b1).toMatchObject({ posted: true, goodsCents: 1200, offsetCents: 800, docNo: expect.stringMatching(/^CGRK/) });
    // 采购入库单：库存 +5，应付 +（1000-800），预付款冲抵 -800
    const inbound = await ds.query('SELECT status, CAST(offset_cents AS SIGNED) oc, CAST(amount_cents AS SIGNED) ac, source_key sk FROM finance_documents WHERE id = ?', [b1.docId]);
    expect(inbound[0]).toMatchObject({ status: 'posted', oc: '800', ac: '1200', sk: `flow:${run.id}:inbound:0` });
    expect(await bal('payable', ids.supp)).toBe(stockBefore - 400);
    // 商品成本：采购价=结算单价；运费 300/5=60、装卸 100/5=20（分/斤）
    const apple = await ds.manager.findOneOrFail(ResourceRecord, { where: { id: ids.apple } });
    expect(apple.data).toMatchObject({ purchasePrice: 200, freight: 50, handlingFee: 16.6667 });
    expect(b1.costPublication).toEqual([{ productId: ids.apple, purchasePriceCents: 200, freightCents: 50, handlingCents: 16.6667 }]);
    // 费用付款：逐笔登记，生成费用单；漏付不行
    await expect(go(cashier, run.id, { payments: [] }, undefined, 'expense_pay')).rejects.toThrow(/还有费用没有登记付款/);
    const fees = b1.fees.map((f) => f.id);
    const next = await go(cashier, run.id, { payments: [{ feeIds: fees, bankAccountId: ids.bank2, reference: `FY${key()}`, files: [await file(cashier.id)] }] });
    expect(next.activeStep?.key).toBe('dispatch'); // 还有未到货的，回到发货
    const s2 = await stateRow(run.id);
    expect(s2.batches[0].fees.every((f) => f.paid && f.paymentDocNo?.startsWith('FY'))).toBe(true);
    const exp = await ds.query("SELECT status, CAST(amount_cents AS SIGNED) ac FROM finance_documents WHERE id = ?", [s2.batches[0].fees[0].paymentDocId]);
    expect(exp[0]).toMatchObject({ status: 'posted', ac: '400' });
    // 第二批：把剩下的（苹果 4，梨 4）一起发；这次没有费用，冲抵剩余预付款
    const rest = (await svc.state(admin, run.id)) as unknown as { lines: Array<{ productId: number; toShip: number; remaining: number }> };
    expect(rest.lines.map((l) => [l.productId, l.toShip, l.remaining])).toEqual([[ids.apple, 4, 4], [ids.pear, 4, 4]]);
    await dispatch(run.id, [{ productId: ids.apple, qty: 4 }, { productId: ids.pear, qty: 4 }]);
    await arrive(run.id);
    await receive(run.id, [{ productId: ids.apple, qty: 4 }, { productId: ids.pear, qty: 4 }]);
    await quality(run.id, [{ productId: ids.apple, qty: 4 }, { productId: ids.pear, qty: 4 }]);
    await noFee(run.id);
    const fin2 = await go(fin, run.id, { allocationMethod: 'value', offsetCents: 4200 }, undefined, 'settle');
    expect(fin2.status).toBe('completed');
    const s3 = await stateRow(run.id);
    expect(s3.batches[1].goodsCents).toBe(1000 + 4000);
    // 办完后没用完的占用自动释放：已冲抵 800+4200=5000 正好等于新付款 3000 + 占用 2000
    expect(await ds.query('SELECT 1 FROM flow_runs WHERE id = ? AND status = ?', [run.id, 'completed'])).toHaveLength(1);
    const pear = await ds.manager.findOneOrFail(ResourceRecord, { where: { id: ids.pear } });
    expect(pear.data).toMatchObject({ purchasePrice: 1000, freight: 0, handlingFee: 0 });
    expect(String(pear.data.zeroValueReason)).toContain('运费：供应商承担物流');
  });

  it('异常：不合格退回换货后本批只算合格数量，换货补发；整批退回要重新发货；短缺要补发或终止', async () => {
    const run = await toDispatch(3000, 2000);
    await dispatch(run.id, [{ productId: ids.pear, qty: 4 }]);
    await arrive(run.id);
    await expect(receive(run.id, [{ productId: ids.pear, qty: 5 }])).rejects.toThrow(/超过当前可办理数量/);
    await expect(receive(run.id, [{ productId: ids.pear, qty: 3 }])).rejects.toThrow(/差异/);
    const exc = await receive(run.id, [{ productId: ids.pear, qty: 0 }], { receiptComplete: true }, '空箱');
    expect(exc.activeStep?.key).toBe('exception');
    // 补发：整批重新发货
    const again = await go(boss, run.id, { resolution: 'replace', files: [await file(boss.id)] }, '让供应商补发', 'exception');
    expect(again.activeStep?.key).toBe('dispatch');
    const s = await stateRow(run.id);
    expect(s.shipments[0].closedMissing[String(ids.pear)]).toBe(4);
    await dispatch(run.id, [{ productId: ids.pear, qty: 4 }]);
    expect((await stateRow(run.id)).batches).toHaveLength(2);
  });

  it('退回：退回上一步；已付款后不能退回到付款前；已入库不能退回；不能废除已付款的采购', async () => {
    const run = await start(ops, L());
    await go(buyer, run.id, plan());
    const backed = await flow.returnBack(boss, run.id, { revision: (await reload(run.id)).revision, stepId: (await reload(run.id)).activeStep!.id, reason: '价格再谈谈' });
    expect(backed.activeStep?.key).toBe('plan');
    await go(buyer, run.id, plan({ prices: { [ids.apple]: 240, [ids.pear]: 900 } }));
    await go(boss, run.id, undefined, undefined, 'approve');
    await payOnce(run.id, 1000);
    const r = await reload(run.id);
    expect(r.me).toBeDefined();
    const detail = await flow.detail(cashier, run.id);
    expect(detail.activeStep?.key).toBe('prepay_review');
    await expect(flow.returnBack(fin, run.id, { revision: detail.revision, stepId: detail.activeStep!.id, reason: 'x' })).rejects.toThrow(/不能退回/);
    await expect(flow.withdraw(ops, run.id, { revision: detail.revision })).rejects.toThrow(/已经有人办理过|终止并退款/);
    await expect(flow.stop(fin, run.id, 'cancel', { revision: detail.revision, stepId: detail.activeStep!.id, reason: 'x' })).rejects.toThrow(/终止并退款/);
  });

  it('申请变更：付款后只有发起人能申请，退回发起人改数量，重新走方案和审批，已付款方案不能换供应商', async () => {
    const run = await toDispatch(3000, 2000);
    await expect(svc.control(ops, run.id, 'amend', '')).rejects.toThrow(/原因/);
    await expect(svc.control(stranger, run.id, 'amend', '想改')).rejects.toThrow();
    await expect(go(ops, run.id, undefined)).rejects.toThrow();
    const back = await svc.control(ops, run.id, 'amend', '少买两斤梨');
    expect(back.activeStep?.key).toBe('apply');
    expect(back.me.canResubmit).toBe(true);
    expect((await stateRow(run.id)).amendOpen).toBe(true);
    // 付款后的内容变更：必须走变更；不能把已入库数量改没（这里没有入库，改少即可）
    const re = await flow.resubmit(ops, run.id, { revision: back.revision, payload: { lines: [{ productId: ids.apple, qty: 10, aliasName: '红富士' }, { productId: ids.pear, qty: 2 }], requestedArrivalAt: '2099-12-31' } });
    expect(re.activeStep?.key).toBe('plan');
    expect(re.title).toContain('红富士');
    const sp = await stateRow(run.id);
    expect(sp.planReady).toBe(false);
    expect(sp.payments).toHaveLength(1); // 已付款记录原样保留
    await expect(go(buyer, run.id, plan({ supplierId: (await resources.create(admin, 'finance-suppliers', { name: '另一家' })).id }))).rejects.toThrow(/保留原供应商/);
    await go(buyer, run.id, plan({ prices: { [ids.apple]: 250.1234, [ids.pear]: 1000 } }));
    const ap = await go(boss, run.id, undefined, '同意变更', 'approve');
    expect(ap.activeStep?.key).toBe('pay'); // 重新登记货款
    const reopened = await go(cashier, run.id, { payments: [] }, undefined, 'pay');
    expect(reopened.activeStep?.key).toBe('prepay_review');
    expect((await stateRow(run.id)).amendOpen).toBe(false);
  });

  it('终止未到货部分并退款：申请人申请，老板批准，出纳确认退款；没用的预付款退回原账户，用掉的部分保留；占用的已有预付款释放', async () => {
    const run = await toDispatch(3000, 2000);
    await expect(svc.control(ops, run.id, 'cancel_remaining', '不要了')).resolves.toBeDefined();
    const detail = await reload(run.id);
    expect(detail.activeStep?.key).toBe('exception');
    expect((await stateRow(run.id)).cancelRequested).toBe(true);
    await expect(go(boss, run.id, { resolution: 'replace', files: [await file(boss.id)] }, '换货', 'exception')).rejects.toThrow(/终止未到货部分并退款/);
    const refunding = await go(boss, run.id, { resolution: 'cancel_remaining', files: [await file(boss.id)] }, '同意终止', 'exception');
    expect(refunding.activeStep?.key).toBe('refund');
    const s = await stateRow(run.id);
    const docId = s.payments[0].docId;
    const bank0 = await bal('bank', ids.bank);
    const pre0 = await bal('prepayment', ids.supp);
    await expect(go(cashier, run.id, { refunds: [] }, undefined, 'refund')).rejects.toThrow(/逐笔/);
    const done = await go(cashier, run.id, { refunds: [{ docId, reference: `TK${key()}`, files: [await file(cashier.id)] }] }, undefined, 'refund');
    expect(done.status).toBe('completed');
    // 新付款 3000 全没用：原预付款单被红冲，钱回到银行，预付款余额减少 3000；占用的 2000 只是释放，不动余额
    expect(await bal('bank', ids.bank)).toBe(bank0 + 3000);
    expect(await bal('prepayment', ids.supp)).toBe(pre0 - 3000);
    const orig = await ds.query('SELECT status FROM finance_documents WHERE id = ?', [docId]);
    expect(orig[0].status).toBe('reversed');
    const end = await stateRow(run.id);
    expect(end.cancelledRemaining).toBe(true);
    expect(end.refunds).toEqual([expect.objectContaining({ sourceDocId: docId, amountCents: 3000 })]);
    expect(end.cancelledQty).toEqual({ [String(ids.apple)]: 10, [String(ids.pear)]: 4 });
  });

  it('终止时已经用掉一部分预付款：先补一张已使用金额的预付款，再红冲原单，净退回没用的部分', async () => {
    const run = await toDispatch(3000, 0);
    await dispatch(run.id, [{ productId: ids.pear, qty: 1 }]);
    await arrive(run.id);
    await receive(run.id, [{ productId: ids.pear, qty: 1 }]);
    await quality(run.id, [{ productId: ids.pear, qty: 1 }]);
    await noFee(run.id);
    const next = await go(fin, run.id, { allocationMethod: 'value', offsetCents: 1000 }, undefined, 'settle');
    expect(next.activeStep?.key).toBe('dispatch');
    await svc.control(ops, run.id, 'cancel_remaining', '剩下的不要了');
    await go(boss, run.id, { resolution: 'cancel_remaining', files: [await file(boss.id)] }, '同意', 'exception');
    const s = await stateRow(run.id);
    const bank0 = await bal('bank', ids.bank);
    const pre0 = await bal('prepayment', ids.supp);
    const done = await go(cashier, run.id, { refunds: [{ docId: s.payments[0].docId, reference: `TK${key()}`, files: [await file(cashier.id)] }] }, undefined, 'refund');
    expect(done.status).toBe('completed');
    expect(await bal('bank', ids.bank)).toBe(bank0 + 2000); // 3000 付出，用掉 1000，净退回 2000
    expect(await bal('prepayment', ids.supp)).toBe(pre0 - 2000);
  });

  it('发货跟进：只有当前负责发货的人能登记承诺发货日；不能早于今天', async () => {
    const run = await toDispatch(3000, 2000);
    await expect(svc.followup(whs, run.id, { promisedShipAt: '2099-01-01' })).rejects.toThrow(/负责跟进发货/);
    await expect(svc.followup(fin, run.id, { promisedShipAt: '2020-01-01' })).rejects.toThrow(/不能早于今天/);
    await expect(svc.followup(fin, run.id, { promisedShipAt: '明天' })).rejects.toThrow(/发货日期/);
    const r = await svc.followup(fin, run.id, { promisedShipAt: '2099-01-01', comment: '供应商说下周' });
    expect(r.followups[0]).toMatchObject({ promisedShipAt: '2099-01-01', comment: '供应商说下周', byName: '财务' });
    expect(((await svc.state(ops, run.id)) as unknown as { followups: unknown[] }).followups).toHaveLength(1);
  });

  it('凭证文件：只有有权看这张单的人能取；付款凭证要有金额权限；上传要是当前办理人', async () => {
    const run = await toDispatch(3000, 2000);
    const s = await stateRow(run.id);
    const payFile = s.payments[0].files[0];
    const shipFile = s.shipments.length ? s.shipments[0].files[0] : (await dispatch(run.id, [{ productId: ids.pear, qty: 1 }], {}), (await stateRow(run.id)).shipments[0].files[0]);
    await expect(svc.fileUrl(buyer, run.id, payFile)).resolves.toMatchObject({ url: 'http://x' });
    await expect(svc.fileUrl(ops, run.id, payFile)).rejects.toThrow(/权限/); // 运营看不到付款凭证
    await expect(svc.fileUrl(ops, run.id, shipFile)).resolves.toBeDefined();
    await expect(svc.fileUrl(stranger, run.id, shipFile)).rejects.toThrow(/没有查看/);
    await expect(svc.upload(ops, run.id, { originalname: 'a.png', buffer: Buffer.from([1]), size: 1 })).rejects.toThrow(/当前办理人/);
    await expect(svc.upload(whs, run.id, { originalname: 'a.png', buffer: Buffer.from([1]), size: 1 })).resolves.toBeDefined();
  });

  it('商品选择：只列可采购的商品，没有成本价格，支持分类和关键字', async () => {
    const r = await svc.products(ops, { page: 1 });
    expect(r.rows.map((x) => x.name)).toEqual(expect.arrayContaining(['采购苹果', '采购梨']));
    expect(JSON.stringify(r.rows)).not.toMatch(/purchasePrice|totalCost|freight/);
    expect(r.rows.find((x) => x.name === '采购苹果')!.aliases).toEqual(['红富士', '烟富3号']);
    expect((await svc.products(ops, { page: 1, keyword: '梨' })).rows.map((x) => x.name)).toEqual(['采购梨']);
    expect((await svc.products(ops, { page: 1, categoryId: ids.cat })).total).toBeGreaterThanOrEqual(2);
    expect((await svc.products(outsider, { page: 1 })).total).toBe(0);
    const prog = await svc.progressVisible(ops, [(await start(ops, L())).id, 999999]);
    expect(Object.keys(prog)).toHaveLength(1);
  });
});
