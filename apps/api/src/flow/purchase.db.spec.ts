/** 采购申请流程的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=<库名> npx jest --runInBand purchase */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { getFlowTemplate, type StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FinanceDocument, FlowRun, User } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { FlowService } from './flow.service';
import { PurchaseService } from './purchase.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('采购申请流程（真实数据库）', () => {
  let ds: DataSource;
  let flow: FlowService;
  let purchase: PurchaseService;
  let docs: FinanceDocumentsService;
  let resources: ReturnType<typeof buildServices>['resources'];
  let admin: AuthUser, req: AuthUser, mgr: AuthUser, buyer: AuthUser, lead: AuthUser, fin: AuthUser, boss: AuthUser, cashier: AuthUser, keeper: AuthUser, plain: AuthUser, outsider: AuthUser;
  const ids: Record<string, number> = {};
  const key = () => crypto.randomBytes(8).toString('hex') + 'abcd';
  const COST = 'product.cost.view';
  const future = '2099-01-01';

  const mkUser = async (companyId: number, account: string, name: string, extra: Partial<User> = {}) =>
    (await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra }))).id;
  const au = (id: number, companyId: number, name: string, allow: string[] = []): AuthUser => ({ id, companyId, name, permissions: { isCompanyAdmin: false, allow: ['flow.apply.view', ...allow], deny: [] } });

  const apply = (u: AuthUser, over: Record<string, unknown> = {}, k: string = key()) => flow.start(u, 'purchase-request', {
    purpose: 'restock', reason: '库存见底', lines: [{ productId: ids.p1, qty: 100, unit: '箱' }, { productId: ids.p2, qty: 2.5 }], expectedArrivalDate: future, ...over,
  }, k);
  const act = async (u: AuthUser, runId: number, form: Record<string, unknown> = {}, comment?: string) => {
    const r = await flow.detail(u, runId);
    return flow.pass(u, runId, { revision: r.revision, stepId: r.activeStep!.id, form, comment });
  };
  const planForm = (over: Record<string, unknown> = {}) => ({ supplierId: ids.supp, prices: [{ productId: ids.p1, unitPriceCents: 1250.5 }, { productId: ids.p2, unitPriceCents: 800 }], ...over });
  // 100×12.505元 + 2.5×8元 = 1250.50 + 20 = 1270.50 元 = 127050 分
  const TOTAL = 127050;
  const orderForm = (over: Record<string, unknown> = {}) => ({
    orderNo: 'PO-1', orderedAt: '2026-10-01', promisedArrivalDate: '2026-10-10', paymentMode: 'prepay', bankAccountId: ids.bank, paidCents: TOTAL, paidAt: '2026-10-01', payRef: `LS-${key()}`, ...over,
  });
  const recvForm = (a: number, b: number, over: Record<string, unknown> = {}) => ({
    arrivedAt: '2026-10-09', lines: [{ productId: ids.p1, receivedQty: a, acceptedQty: a }, { productId: ids.p2, receivedQty: b, acceptedQty: b }], ...over,
  });
  /** 走到“到货验收”：部门审核→方案→采购负责人→财务→（大额则老板）→下单 */
  async function toReceive(over: { apply?: Record<string, unknown>; plan?: Record<string, unknown>; order?: Record<string, unknown> } = {}) {
    const run = await apply(req, over.apply);
    await act(mgr, run.id);
    await act(buyer, run.id, planForm(over.plan));
    await act(lead, run.id);
    await act(fin, run.id);
    const r = await flow.detail(admin, run.id);
    if (r.activeStep?.key === 'boss_review') await act(boss, run.id);
    await act(cashier, run.id, orderForm(over.order));
    return run.id;
  }

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    resources = s.resources;
    docs = new FinanceDocumentsService(ds);
    flow = new FlowService(ds, resources, docs);
    purchase = new PurchaseService(ds, flow, docs);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `p${crypto.randomBytes(5).toString('hex')}`, name: '采购流程测试', status: 'active' }));
    const c2 = await ds.manager.save(Company, ds.manager.create(Company, { code: `p${crypto.randomBytes(5).toString('hex')}`, name: '别家公司', status: 'active' }));
    admin = { id: await mkUser(c.id, 'padmin', '管理员', { isCompanyAdmin: true }), companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    req = au(await mkUser(c.id, 'preq', '申请人'), c.id, '申请人');
    mgr = au(await mkUser(c.id, 'pmgr', '部门主管'), c.id, '部门主管');
    buyer = au(await mkUser(c.id, 'pbuyer', '采购员'), c.id, '采购员', [COST]);
    lead = au(await mkUser(c.id, 'plead', '采购负责人'), c.id, '采购负责人', [COST]);
    fin = au(await mkUser(c.id, 'pfin', '财务'), c.id, '财务', [COST]);
    boss = au(await mkUser(c.id, 'pboss', '老板'), c.id, '老板', [COST]);
    cashier = au(await mkUser(c.id, 'pcash', '出纳'), c.id, '出纳', [COST]);
    keeper = au(await mkUser(c.id, 'pkeep', '仓管'), c.id, '仓管', ['flow.purchase.inbound-draft']);
    plain = au(await mkUser(c.id, 'pplain', '路人'), c.id, '路人');
    outsider = { id: await mkUser(c2.id, 'pout', '外人', { isCompanyAdmin: true }), companyId: c2.id, name: '外人', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };

    const cat = (await resources.create(admin, 'finance-categories', { archiveType: 'raw', name: '采购测试类', code: 'CGT' })).id;
    const zero = { zeroValueReason: '运费：无\n装卸费：无' };
    const prod = async (u: AuthUser, name: string, extra: Record<string, unknown> = {}) => (await resources.create(u, 'finance-products', { archiveType: 'raw', name, categoryId: cat, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 500, freight: 0, handlingFee: 0, ...zero, ...extra })).id;
    ids.p1 = await prod(admin, '采购测试苹果');
    ids.p2 = await prod(admin, '采购测试梨');
    ids.stopped = await prod(admin, '停用的货');
    await ds.query("UPDATE resource_records SET status = 'inactive' WHERE id = ?", [ids.stopped]);
    const cat2 = (await resources.create(outsider, 'finance-categories', { archiveType: 'raw', name: '别家类', code: 'BJL' })).id;
    ids.foreign = (await resources.create(outsider, 'finance-products', { archiveType: 'raw', name: '别家的货', categoryId: cat2, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 500, freight: 0, handlingFee: 0, ...zero })).id;
    ids.supp = (await resources.create(admin, 'finance-suppliers', { name: '果园' })).id;
    ids.foreignSupp = (await resources.create(outsider, 'finance-suppliers', { name: '别家供应商' })).id;
    ids.wh = (await resources.create(admin, 'finance-warehouses', { name: '一号仓' })).id;
    ids.foreignWh = (await resources.create(outsider, 'finance-warehouses', { name: '别家仓' })).id;
    ids.bank = (await resources.create(admin, 'bank-accounts', { kind: 'company_public', accountName: '公户', bank: '测试银行', accountNo: '6222000011112222', balance: 1000000 })).id;
    ids.foreignBank = (await resources.create(outsider, 'bank-accounts', { kind: 'company_public', accountName: '别家公户', bank: '测试银行', accountNo: '6222000099998888' })).id;

    // 按模板默认步骤配置办理人（含大额条件、验收异常的退回目标）
    const tpl = getFlowTemplate('purchase-request')!;
    const who: Record<string, AuthUser> = { dept_review: mgr, plan: buyer, plan_review: lead, finance_review: fin, boss_review: boss, order: cashier, receive: keeper, exception: lead, refund_confirm: cashier, inbound: keeper, final_pay: cashier };
    const steps = tpl.steps.map((st) => (who[st.key] ? ({ ...st, assignee: { source: 'employee', id: who[st.key].id } } as StepDef) : { ...st }));
    await flow.saveDraft(admin, 'purchase-request', steps, [boss.id]);
    await flow.publish(admin, 'purchase-request');
  });
  afterAll(async () => { await ds?.destroy(); });

  it('发起校验：商品要存在、启用、同公司、不重复，数量和日期合法', async () => {
    await expect(apply(req, { lines: [] })).rejects.toThrow(/不能为空|至少添加/);
    await expect(apply(req, { lines: [{ productId: ids.p1, qty: 1 }, { productId: ids.p1, qty: 2 }] })).rejects.toThrow(/重复/);
    await expect(apply(req, { lines: [{ productId: ids.p1, qty: 0 }] })).rejects.toThrow(/大于 0/);
    await expect(apply(req, { lines: [{ productId: ids.p1, qty: 1.00001 }] })).rejects.toThrow(/数量/);
    await expect(apply(req, { lines: [{ productId: ids.stopped, qty: 1 }] })).rejects.toThrow(/已停用/);
    await expect(apply(req, { lines: [{ productId: ids.foreign, qty: 1 }] })).rejects.toThrow(/不存在/);
    await expect(apply(req, { expectedArrivalDate: '2020-01-01' })).rejects.toThrow(/不能早于今天/);
    await expect(apply(req, { suggestedSupplierId: ids.foreignSupp })).rejects.toThrow(/建议供应商不存在/);
    await expect(apply(plain, { reason: '' })).rejects.toThrow(/采购事由/);
    const noApply: AuthUser = { ...plain, permissions: { isCompanyAdmin: false, allow: [], deny: [] } };
    await expect(apply(noApply)).rejects.toThrow(/权限/);
  });

  it('正常流转（小额、全款预付）：部门审核→方案→采购负责人→财务→下单→验收→入库登记（生成草稿）→完成；不经过老板和异常', async () => {
    const run = await apply(req, { storeId: undefined, projectName: '十月备货' });
    expect(run.title).toContain('采购申请 · 采购测试苹果 等 2 项');
    expect(run.activeStep?.key).toBe('dept_review');
    expect(run.activeStep?.recipients.map((r) => r.name)).toEqual(['部门主管']);
    const cur = await flow.detail(req, run.id);
    await expect(flow.pass(plain, run.id, { revision: cur.revision, stepId: cur.activeStep!.id })).rejects.toThrow(/不是你办理/);
    await act(mgr, run.id, {}, '同意');
    let r = await flow.detail(buyer, run.id);
    expect(r.activeStep?.key).toBe('plan');
    // 方案：单价缺失、供应商是别家的、停用，都不行
    await expect(act(buyer, run.id, planForm({ prices: [{ productId: ids.p1, unitPriceCents: 1250.5 }] }))).rejects.toThrow(/还没有填/);
    await expect(act(buyer, run.id, planForm({ prices: [{ productId: ids.p1, unitPriceCents: 1.00001 }, { productId: ids.p2, unitPriceCents: 1 }] }))).rejects.toThrow(/单价/);
    await expect(act(buyer, run.id, planForm({ supplierId: ids.foreignSupp }))).rejects.toThrow(/供应商不存在/);
    // 没有成本查看权限的人办理方案：填不了单价
    r = await flow.detail(buyer, run.id);
    const noCostBuyer = { ...buyer, permissions: { isCompanyAdmin: false, allow: ['flow.apply.view'], deny: [] } };
    await expect(flow.pass(noCostBuyer, run.id, { revision: r.revision, stepId: r.activeStep!.id, form: planForm() })).rejects.toThrow(/成本查看/);
    await act(buyer, run.id, planForm());
    // 金额由系统按数量×单价算出，并写进办理表单（条件分支读它）
    const sRaw = await ds.query("SELECT form FROM flow_steps WHERE run_id = ? AND step_key = 'plan' AND status = 'done'", [run.id]);
    expect(JSON.parse(typeof sRaw[0].form === 'string' ? sRaw[0].form : JSON.stringify(sRaw[0].form)).amountCents).toBe(TOTAL);
    await act(lead, run.id);
    await act(fin, run.id);
    r = await flow.detail(cashier, run.id);
    expect(r.activeStep?.key).toBe('order'); // 小额：老板审批被跳过
    expect(r.steps.find((x) => x.key === 'boss_review')?.status).toBe('skipped');
    // 下单：全款预付金额必须等于采购金额；超额不行；账户要同公司；缺流水号不行
    await expect(act(cashier, run.id, orderForm({ paidCents: TOTAL - 1 }))).rejects.toThrow(/必须等于采购金额/);
    await expect(act(cashier, run.id, orderForm({ paidCents: TOTAL + 1 }))).rejects.toThrow(/超过已批准/);
    await expect(act(cashier, run.id, orderForm({ bankAccountId: ids.foreignBank }))).rejects.toThrow(/付款账户不存在/);
    await expect(act(cashier, run.id, orderForm({ payRef: '' }))).rejects.toThrow(/流水号/);
    await expect(act(cashier, run.id, orderForm({ promisedArrivalDate: '2026-09-01' }))).rejects.toThrow(/不能早于下单/);
    const ref = `LS-${key()}`;
    await act(cashier, run.id, orderForm({ payRef: ref }));
    r = await flow.detail(keeper, run.id);
    expect(r.activeStep?.key).toBe('receive');
    // 到货验收的截止时间是供应商承诺到货日当天 23:59（业务日期督促）
    expect(new Date(r.activeStep!.dueAt!).toISOString()).toBe('2026-10-10T15:59:59.000Z');
    // 验收：合格不能大于到货；超过申请数量不行
    await expect(act(keeper, run.id, recvForm(100, 2.5, { lines: [{ productId: ids.p1, receivedQty: 5, acceptedQty: 6 }] }))).rejects.toThrow(/合格数量不能大于到货/);
    await expect(act(keeper, run.id, recvForm(101, 2.5))).rejects.toThrow(/超过了申请数量/);
    await act(keeper, run.id, recvForm(100, 2.5));
    r = await flow.detail(keeper, run.id);
    expect(r.steps.find((x) => x.key === 'exception')?.status).toBe('skipped'); // 全部合格：不走异常
    expect(r.activeStep?.key).toBe('inbound');
    // 入库登记：不生成草稿也不写原因 → 不让过；非权限人不能生成草稿
    await expect(act(keeper, run.id, {})).rejects.toThrow(/生成采购入库单草稿/);
    await expect(purchase.inboundDraft(plain, run.id, { warehouseId: ids.wh })).rejects.toThrow(/不是你办理/);
    await expect(purchase.inboundDraft(keeper, run.id, { warehouseId: ids.foreignWh })).rejects.toThrow(/仓库不存在/);
    const g1 = await purchase.inboundDraft(keeper, run.id, { warehouseId: ids.wh, date: '2026-10-10' });
    expect(g1.already).toBe(false);
    const g2 = await purchase.inboundDraft(keeper, run.id, { warehouseId: ids.wh });
    expect(g2).toMatchObject({ docId: g1.docId, already: true }); // 幂等
    const doc = await ds.manager.findOneOrFail(FinanceDocument, { where: { id: g1.docId } });
    expect(doc).toMatchObject({ docType: 'purchase-in', status: 'draft', amountCents: TOTAL, partyId: ids.supp, warehouseId: ids.wh });
    const entries = await ds.query('SELECT COUNT(*) AS n FROM finance_entries WHERE document_id = ?', [doc.id]);
    expect(Number(entries[0].n)).toBe(0); // 只是草稿：没有分录，没过账
    // 生成草稿后不能再废除
    r = await flow.detail(keeper, run.id);
    expect(r.me.canCancel).toBe(false);
    expect(r.me.cancelBlockedReason).toMatch(/入库单草稿/);
    await act(keeper, run.id, {});
    r = await flow.detail(req, run.id);
    expect(r.status).toBe('completed');
    expect(r.steps.find((x) => x.key === 'final_pay')?.status).toBe('skipped'); // 全款预付：没有尾款
    expect(r.events.some((e) => e.action === 'draft')).toBe(true);
    // 流水号不能在别的采购流程里重复登记
    const other = await toReceiveUntilOrder();
    await expect(act(cashier, other, orderForm({ payRef: ref }))).rejects.toThrow(/已经在采购流程里登记过/);
  });

  async function toReceiveUntilOrder() {
    const run = await apply(req);
    await act(mgr, run.id); await act(buyer, run.id, planForm()); await act(lead, run.id); await act(fin, run.id);
    return run.id;
  }

  it('金额条件分支：达到门槛才走老板审批；门槛可在设计器里改', async () => {
    const big = await apply(req);
    await act(mgr, big.id);
    await act(buyer, big.id, planForm({ prices: [{ productId: ids.p1, unitPriceCents: 100000 }, { productId: ids.p2, unitPriceCents: 800 }] })); // 100×1000 元=10 万元
    await act(lead, big.id); await act(fin, big.id);
    let r = await flow.detail(boss, big.id);
    expect(r.activeStep?.key).toBe('boss_review');
    expect(r.activeStep?.recipients.map((x) => x.name)).toEqual(['老板']);
    await act(boss, big.id);
    r = await flow.detail(cashier, big.id);
    expect(r.activeStep?.key).toBe('order');
    // 刚好等于门槛（1,000,000 分）也走老板；差 1 分不走
    const edge = async (unit: number) => {
      const run = await apply(req, { lines: [{ productId: ids.p1, qty: 1 }] });
      await act(mgr, run.id); await act(buyer, run.id, planForm({ prices: [{ productId: ids.p1, unitPriceCents: unit }] })); await act(lead, run.id); await act(fin, run.id);
      return (await flow.detail(admin, run.id)).activeStep?.key;
    };
    expect(await edge(1_000_000)).toBe('boss_review');
    expect(await edge(999_999)).toBe('order');
  });

  it('预付定金：尾款到货后付；累计付款不能超过批准金额；账期可不付款', async () => {
    const id = await toReceive({ order: { paymentMode: 'deposit', paidCents: 50000 } });
    await expect(act(cashier, (await toReceiveUntilOrder()), orderForm({ paymentMode: 'deposit', paidCents: TOTAL }))).rejects.toThrow(/必须小于采购金额/);
    await act(keeper, id, recvForm(100, 2.5));
    await purchase.inboundDraft(keeper, id, { warehouseId: ids.wh });
    await act(keeper, id, {});
    let r = await flow.detail(cashier, id);
    expect(r.activeStep?.key).toBe('final_pay');
    await expect(act(cashier, id, { bankAccountId: ids.bank, paidCents: TOTAL, paidAt: '2026-10-12', payRef: `LS-${key()}` })).rejects.toThrow(/累计付款不能超过/);
    await act(cashier, id, { bankAccountId: ids.bank, paidCents: TOTAL - 50000, paidAt: '2026-10-12', payRef: `LS-${key()}` });
    r = await flow.detail(cashier, id);
    expect(r.status).toBe('completed');
    // 账期：下单不付款，尾款步骤出现
    const credit = await toReceive({ order: { paymentMode: 'credit', paidCents: undefined, bankAccountId: undefined, paidAt: undefined, payRef: undefined } });
    expect((await flow.detail(keeper, credit)).activeStep?.key).toBe('receive');
  });

  it('成本脱敏：没有成本查看权限的人，接口里没有单价、金额、付款；有权限的人看得到；受限字段重新提交不丢', async () => {
    const run = await apply(req, {}, key());
    await act(mgr, run.id);
    await act(buyer, run.id, planForm());
    const forReq = await flow.detail(req, run.id);
    const text = JSON.stringify(forReq);
    expect(text).not.toContain('unitPriceCents');
    expect(text).not.toContain(String(TOTAL));
    expect(forReq.fields.some((f) => f.key === 'estimates')).toBe(false);
    const planStep = forReq.steps.find((s) => s.key === 'plan')!;
    expect(planStep.form).not.toHaveProperty('prices');
    expect(planStep.form).not.toHaveProperty('amountCents');
    expect(forReq.stepFields.plan.some((f) => f.key === 'prices' || f.key === 'amountCents')).toBe(false);
    const viewer = au(fin.id, fin.companyId, '总览财务', [COST, 'flow.overview.view']);
    const forFin = await flow.detail(viewer, run.id);
    expect(forFin.steps.find((s) => s.key === 'plan')!.form).toMatchObject({ amountCents: TOTAL });
    // 模板目录也按权限过滤字段：没有成本权限的人看不到预计单价、单价字段
    const tplReq = (await flow.templates(req)).find((t) => t.key === 'purchase-request')!;
    expect(tplReq.fields.some((f) => f.key === 'estimates')).toBe(false);
    expect(tplReq.stepFields.plan.some((f) => f.key === 'prices')).toBe(false);
    const tplFin = (await flow.templates(viewer)).find((t) => t.key === 'purchase-request')!;
    expect(tplFin.fields.some((f) => f.key === 'estimates')).toBe(true);
    expect(tplFin.stepFields.plan.some((f) => f.key === 'prices')).toBe(true);
    // 摘要接口同样脱敏
    const sReq = await purchase.summary(req, run.id);
    expect(sReq.canSeeMoney).toBe(false);
    expect(JSON.stringify(sReq)).not.toContain('unitPriceCents');
    expect(sReq).not.toHaveProperty('totalCents');
    const sFin = await purchase.summary(viewer, run.id);
    expect(sFin.totalCents).toBe(TOTAL);
    expect(sFin.lines[0].unitPriceCents).toBe(1250.5);
    // 申请人没有成本权限时，提交的预计单价被丢弃；有权限的人填了，别的人看不到，重新提交（看不到的人）不会清掉
    const estim = [{ productId: ids.p1, unitPriceCents: 1000 }, { productId: ids.p2, unitPriceCents: 700 }];
    const noCostReq = await apply(req, { estimates: estim });
    expect(await ds.query("SELECT JSON_EXTRACT(payload, '$.estimates') AS e FROM flow_runs WHERE id = ?", [noCostReq.id])).toEqual([{ e: null }]);
    const costReq = au(req.id, req.companyId, '申请人(有成本权限)', [COST]);
    const withEst = await apply(costReq, { estimates: estim });
    expect((await flow.detail(costReq, withEst.id)).payload.estimates).toBeDefined();
    expect((await flow.detail(mgr, withEst.id)).payload).not.toHaveProperty('estimates');
    const returned = await flow.detail(mgr, withEst.id);
    await flow.returnBack(mgr, withEst.id, { revision: returned.revision, stepId: returned.activeStep!.id, reason: '数量再核对' });
    const back = await flow.detail(req, withEst.id);
    await flow.resubmit(req, withEst.id, { revision: back.revision, payload: { purpose: 'restock', reason: '改过', lines: [{ productId: ids.p1, qty: 50 }], expectedArrivalDate: future } });
    const kept = await ds.manager.findOneOrFail(FlowRun, { where: { id: withEst.id } });
    expect(kept.payload.estimates).toEqual([estim[0]]); // 看不到预计单价的人重新提交，原值保留；申请里已经去掉的商品，对应的预计单价一并去掉
    expect(kept.payload.lines).toEqual([{ productId: ids.p1, qty: 50 }]);
  });

  it('退回重提、撤回：被退回到申请人修改后重新提交，重新走审核；已有人办理过不能撤回', async () => {
    const run = await apply(req);
    let r = await flow.detail(mgr, run.id);
    await flow.returnBack(mgr, run.id, { revision: r.revision, stepId: r.activeStep!.id, reason: '数量写错了' });
    r = await flow.detail(req, run.id);
    expect(r.me.canResubmit).toBe(true);
    expect(r.activeStep?.type).toBe('submit');
    await flow.resubmit(req, run.id, { revision: r.revision, payload: { purpose: 'restock', reason: '数量已改', lines: [{ productId: ids.p1, qty: 20 }], expectedArrivalDate: future } });
    r = await flow.detail(mgr, run.id);
    expect(r.activeStep?.key).toBe('dept_review');
    await act(mgr, run.id);
    r = await flow.detail(req, run.id);
    expect(r.me.canWithdraw).toBe(false);
    // 没人办理过的可以撤回
    const w = await apply(req);
    const wd = await flow.detail(req, w.id);
    expect(wd.me.canWithdraw).toBe(true);
    const res = await flow.withdraw(req, w.id, { revision: wd.revision, reason: '不买了' });
    expect(res.status).toBe('cancelled');
    // 后面的步骤退回：采购负责人把方案退回给采购员重做
    const run2 = await apply(req);
    await act(mgr, run2.id); await act(buyer, run2.id, planForm());
    let r2 = await flow.detail(lead, run2.id);
    await flow.returnBack(lead, run2.id, { revision: r2.revision, stepId: r2.activeStep!.id, reason: '换个供应商' });
    r2 = await flow.detail(buyer, run2.id);
    expect(r2.activeStep).toMatchObject({ key: 'plan', enteredVia: 'return' });
  });

  it('验收短少：走异常处置→退回到验收等补货→分批累计到齐后继续；全部合格才会跳过异常', async () => {
    const id = await toReceive();
    await expect(act(keeper, id, recvForm(60, 2.5))).rejects.toThrow(/验收说明/);
    await act(keeper, id, recvForm(60, 2.5, { note: '先到一批' }));
    let r = await flow.detail(lead, id);
    expect(r.activeStep?.key).toBe('exception');
    expect(r.steps.find((x) => x.key === 'receive')?.form).toMatchObject({ result: 'shortage' });
    // 选“取消未到货部分”需要确实有短少；选“退回供应商”需要确实有不合格
    await expect(act(lead, id, { resolution: 'return_refund', note: 'x' })).rejects.toThrow(/没有不合格品/);
    // 退回上一步 = 等补货，回到到货验收
    await flow.returnBack(lead, id, { revision: r.revision, stepId: r.activeStep!.id, reason: '等剩下的 40 箱' });
    r = await flow.detail(keeper, id);
    expect(r.activeStep).toMatchObject({ key: 'receive', enteredVia: 'return' });
    await act(keeper, id, recvForm(40, 0));
    r = await flow.detail(keeper, id);
    expect(r.steps.filter((x) => x.key === 'receive' && x.status === 'done').length).toBe(2);
    expect(r.activeStep?.key).toBe('inbound'); // 累计合格到齐 → 不再走异常
    const s = await purchase.summary(keeper, id);
    expect(s.lines.map((l) => [l.received, l.accepted])).toEqual([[100, 100], [2.5, 2.5]]);
    expect(s.canGenerateDraft).toBe(true);
  });

  it('验收不合格→退货退款：异常处置选退货→退款到账确认→入库只入合格数量；入库单草稿数量按合格数', async () => {
    const id = await toReceive();
    await act(keeper, id, recvForm(100, 2.5, { lines: [{ productId: ids.p1, receivedQty: 100, acceptedQty: 90 }, { productId: ids.p2, receivedQty: 2.5, acceptedQty: 2.5 }], note: '10 箱破损' }));
    let r = await flow.detail(lead, id);
    expect(r.activeStep?.key).toBe('exception');
    await act(lead, id, { resolution: 'return_refund', note: '破损退货', returnLogisticsNo: 'SF123' });
    r = await flow.detail(cashier, id);
    expect(r.activeStep?.key).toBe('refund_confirm');
    await expect(act(cashier, id, { refundedCents: 0, refundedAt: '2026-10-12' })).rejects.toThrow(/写明原因/);
    await expect(act(cashier, id, { refundedCents: TOTAL + 1, refundedAt: '2026-10-12', note: 'x' })).rejects.toThrow(/不能超过已登记的付款/);
    await act(cashier, id, { refundedCents: 12505, refundedAt: '2026-10-12', refundRef: `TK-${key()}`, bankAccountId: ids.bank });
    r = await flow.detail(keeper, id);
    expect(r.activeStep?.key).toBe('inbound');
    const g = await purchase.inboundDraft(keeper, id, { warehouseId: ids.wh });
    const doc = await ds.manager.findOneOrFail(FinanceDocument, { where: { id: g.docId } });
    // 90×12.505 元 + 2.5×8 元 = 1125.45 + 20 = 1145.45 元
    expect(doc.amountCents).toBe(114545);
    await act(keeper, id, {});
    expect((await flow.detail(req, id)).status).toBe('completed');
  });

  it('供应商一直没发货：登记一件没到→异常处置“取消未到货部分”→退款确认→没有合格数量，入库登记直接过', async () => {
    const id = await toReceive();
    await expect(act(keeper, id, recvForm(0, 0))).rejects.toThrow(/一件都没到/);
    await act(keeper, id, recvForm(0, 0, { note: '供应商一直没发货' }));
    await act(lead, id, { resolution: 'cancel_remaining', note: '取消，要求退款' });
    await act(cashier, id, { refundedCents: TOTAL, refundedAt: '2026-10-20' });
    const r = await flow.detail(keeper, id);
    expect(r.activeStep?.key).toBe('inbound');
    expect((await purchase.summary(keeper, id)).canGenerateDraft).toBe(false);
    await expect(purchase.inboundDraft(keeper, id, { warehouseId: ids.wh })).rejects.toThrow(/没有合格数量/);
    await act(keeper, id, {});
    expect((await flow.detail(req, id)).status).toBe('completed');
  });

  it('已付款或已到货后不能直接废除/退回到付款前；收尾只能走异常处置', async () => {
    const id = await toReceive();
    let r = await flow.detail(keeper, id);
    expect(r.me.canReturn).toBe(false);
    expect(r.me.returnBlockedReason).toMatch(/已经登记了付款/);
    expect(r.me.cancelBlockedReason).toMatch(/已经登记了付款/);
    await expect(flow.stop(keeper, id, 'cancel', { revision: r.revision, stepId: r.activeStep!.id, reason: '不要了' })).rejects.toThrow(/不能直接废除/);
    // 没付款（账期）还没到货时，办理人可以废除
    const credit = await toReceive({ order: { paymentMode: 'credit', paidCents: undefined, bankAccountId: undefined, paidAt: undefined, payRef: undefined } });
    r = await flow.detail(keeper, credit);
    const done = await flow.stop(keeper, credit, 'cancel', { revision: r.revision, stepId: r.activeStep!.id, reason: '供应商涨价，取消' });
    expect(done.status).toBe('cancelled');
  });

  it('权限与公司隔离：别家公司、无关的人看不到；摘要、草稿接口都要身份；附件只能是本流程字段的本人上传文件', async () => {
    const run = await apply(req);
    await expect(flow.detail(outsider, run.id)).rejects.toThrow();
    await expect(purchase.summary(outsider, run.id)).rejects.toThrow();
    await expect(purchase.summary(plain, run.id)).rejects.toThrow(/没有查看/);
    await expect(purchase.inboundDraft(outsider, run.id, { warehouseId: ids.foreignWh })).rejects.toThrow();
    await expect(purchase.inboundDraft(keeper, run.id, { warehouseId: ids.wh })).rejects.toThrow(/不在“入库登记”|现在不在/);
    const opts = await purchase.options(req, '苹果');
    expect(opts.items.map((x) => x.id)).toEqual([ids.p1]);
    expect(JSON.stringify(opts)).not.toContain('purchasePrice');
    expect((await purchase.options(req, '别家')).items).toEqual([]); // 别家公司的商品搜不到
    expect((await purchase.options(req, '停用')).items).toEqual([]);
    // 别人的/别的字段的/别家公司的文件不能挂上
    const f = (await ds.query("INSERT INTO resource_files (company_id, resource_type, resource_id, field_key, storage_key, name, mime, size, uploaded_by) VALUES (?, 'flow:purchase-request', NULL, 'attachments', 'local:x', 'a.png', 'image/png', 1, ?)", [admin.companyId, plain.id])).insertId;
    await expect(apply(req, { attachments: [f] })).rejects.toThrow(/无效的附件/); // 不是申请人自己传的
    const mine = (await ds.query("INSERT INTO resource_files (company_id, resource_type, resource_id, field_key, storage_key, name, mime, size, uploaded_by) VALUES (?, 'flow:purchase-request', NULL, 'attachments', 'local:y', 'b.png', 'image/png', 1, ?)", [admin.companyId, req.id])).insertId;
    const ok = await apply(req, { attachments: [mine] });
    expect((await flow.detail(req, ok.id)).files[mine]).toMatchObject({ name: 'b.png' });
    const bound = await ds.query('SELECT resource_id AS rid FROM resource_files WHERE id = ?', [mine]);
    expect(bound[0].rid).toBe(ok.id);
    await expect(apply(req, { attachments: [mine] })).rejects.toThrow(/无效的附件/); // 已经属于别的流程
  });
});
