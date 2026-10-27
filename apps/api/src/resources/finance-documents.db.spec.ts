/** 财务单据引擎的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test npm test -w @kudesi/api -- finance-documents */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { FeeArchiveService } from './fee-archive.service';
import { EmployeePartyService } from './employee-party.service';
import { FinanceDocumentsService } from './finance-documents.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('财务单据（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let docs: FinanceDocumentsService;
  let boss: AuthUser;
  let clerk: AuthUser; // 只能做草稿，不能过账，也看不到成本
  const ids: Record<string, number> = {};
  const day = '2026-03-10';

  const sum = async (companyId: number, docId?: number) => {
    const where = docId ? 'AND document_id = ?' : '';
    const [r] = await ds.query(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM finance_entries WHERE company_id = ? ${where}`, docId ? [companyId, docId] : [companyId]);
    return Number(r.s);
  };
  const stock = async () => (await docs.inventory(boss, {})).find((x) => x.productId === ids.apple)?.qty ?? 0;

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    docs = new FinanceDocumentsService(ds);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `d${crypto.randomBytes(5).toString('hex')}`, name: '单据测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    clerk = { id: u.id, companyId: c.id, name: '文员', permissions: { isCompanyAdmin: false, allow: ['finance.docs.create', 'finance.doc-sale.view', 'finance.history.view', 'finance.drafts.view', 'finance.doc-purchase-in.view'], deny: [] } };

    const cat = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '单据测试类', code: 'DT' })).id;
    ids.apple = (await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '测试苹果', categoryId: cat, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 500, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' })).id;
    ids.nocost = (await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '没成本的货', categoryId: cat, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' })).id;
    ids.cust = (await svc.create(boss, 'finance-customers', { name: '老客户' })).id;
    ids.supp = (await svc.create(boss, 'finance-suppliers', { name: '果园' })).id;
    ids.store = (await svc.create(boss, 'stores', { name: '提现测试店', platform: 'pdd' })).id;
    ids.wh = (await svc.create(boss, 'finance-warehouses', { name: '一号仓' })).id;
    ids.feeOut = (await svc.create(boss, 'finance-fee-items', { name: '房租', direction: 'expense' })).id;
    ids.feeIn = (await svc.create(boss, 'finance-fee-items', { name: '废品收入', direction: 'income' })).id;
    ids.bank = (await svc.create(boss, 'bank-accounts', { kind: 'company_public', accountName: '公户', bank: '测试银行', accountNo: '6222000011112222', balance: 100000 })).id;
    ids.bank2 = (await svc.create(boss, 'bank-accounts', { kind: 'cashier_account', accountName: '出纳', bank: '测试银行', accountNo: '6222000033334444' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('采购入库：库存增加、应付增加，分录借贷平衡；草稿可改可删，过账后不能改', async () => {
    const draft = await docs.createDraft(boss, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 10, unitPriceCents: 500 }] });
    expect(draft.status).toBe('draft');
    expect(draft.docNo).toMatch(/^CGRK20260310\d{3}$/);
    expect(draft.amountCents).toBe(5000);
    const edited = await docs.updateDraft(boss, draft.id, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 10, unitPriceCents: 500 }, { productId: ids.apple, qty: 2, unitPriceCents: 500 }] });
    expect(edited.amountCents).toBe(6000);
    await docs.updateDraft(boss, draft.id, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 10, unitPriceCents: 500 }] });
    const posted = await docs.post(boss, draft.id); // 草稿直接过账 = 自动开立
    expect(posted.status).toBe('posted');
    expect(await sum(boss.companyId, draft.id)).toBe(0);
    expect(await stock()).toBe(10);
    await expect(docs.updateDraft(boss, draft.id, { type: 'purchase-in', date: day, lines: [] })).rejects.toThrow(/只有草稿/);
    await expect(docs.deleteDraft(boss, draft.id)).rejects.toThrow(/红冲/);
    // 另一张草稿可以删
    const tmp = await docs.createDraft(boss, { type: 'expense', date: day });
    await docs.deleteDraft(boss, tmp.id);
    await expect(docs.get(boss, tmp.id)).rejects.toThrow(/不存在/);
  });

  it('店铺提现：平台应收转为银行到账，银行余额增加，红冲后还原', async () => {
    const before = (await docs.bankBalances(boss)).find((b) => b.id === ids.bank)!.balanceCents;
    const draft = await docs.createDraft(boss, { type: 'withdrawal', date: day, storeId: ids.store, refNo: 'PDD-TX-001', bankAccountId: ids.bank, amountCents: 30000 });
    expect(draft.docNo).toMatch(/^TX20260310\d{3}$/);
    const posted = await docs.post(boss, draft.id);
    expect(posted.entries.map((e) => [e.kind, e.amountCents])).toEqual([['bank', 30000], ['receivable', -30000]]);
    expect((await docs.bankBalances(boss)).find((b) => b.id === ids.bank)!.balanceCents).toBe(before + 30000);
    await docs.reverse(boss, draft.id, '提现撤销');
    expect((await docs.bankBalances(boss)).find((b) => b.id === ids.bank)!.balanceCents).toBe(before);
    await expect(docs.createDraft(boss, { type: 'withdrawal', date: day, bankAccountId: ids.bank, amountCents: 100 }).then((d) => docs.issue(boss, d.id))).rejects.toThrow(/请选择提现的店铺/);
    // 同一个平台流水号不能登记两次
    await expect(docs.createDraft(boss, { type: 'withdrawal', date: day, storeId: ids.store, refNo: 'PDD-TX-001', bankAccountId: ids.bank, amountCents: 100 })).rejects.toThrow(/已经登记过/);
  });

  it('开立会校验完整性；引用必须存在、属于本公司、收支方向要对', async () => {
    const empty = await docs.createDraft(boss, { type: 'sale', date: day });
    await expect(docs.issue(boss, empty.id)).rejects.toThrow(/请选择客户/);
    await expect(docs.createDraft(boss, { type: 'sale', date: day, partyId: 999999 })).rejects.toThrow(/客户不存在/);
    await expect(docs.createDraft(boss, { type: 'expense', date: day, bankAccountId: ids.bank, lines: [{ feeItemId: ids.feeIn, qty: 1, unitPriceCents: 100 }] })).rejects.toThrow(/收支方向/);
    await expect(docs.createDraft(boss, { type: 'sale', date: '2026-13-40' })).rejects.toThrow(/日期/);
  });

  it('销售：收入和成本同时记账，库存减少；库存不够不能卖；成本缺失会提示', async () => {
    const sale = await docs.createDraft(boss, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 4, unitPriceCents: 1200 }] });
    const posted = await docs.post(boss, sale.id);
    expect(posted.entries.map((e) => [e.kind, e.amountCents])).toEqual([['receivable', 4800], ['revenue', -4800], ['cogs', 2000], ['inventory', -2000]]);
    expect(posted.lines[0].unitCostCents).toBe(500); // 成本固定在明细上
    expect(await sum(boss.companyId, sale.id)).toBe(0);
    expect(await stock()).toBe(6);
    const big = await docs.createDraft(boss, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 7, unitPriceCents: 1200 }] });
    await expect(docs.post(boss, big.id)).rejects.toThrow(/库存不够/);
    expect((await docs.get(boss, big.id)).status).toBe('draft'); // 失败整体回滚，状态没变
    const noCost = await docs.createDraft(boss, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, lines: [{ productId: ids.nocost, qty: 1, unitPriceCents: 100 }] });
    await expect(docs.post(boss, noCost.id)).rejects.toThrow(/还没有成本/);
    ids.sale = sale.id;
  });

  it('红冲：生成金额取反的新单据，库存和账都回来；红冲单不能再红冲；必须写原因', async () => {
    await expect(docs.reverse(boss, ids.sale, '')).rejects.toThrow(/原因/);
    const rev = await docs.reverse(boss, ids.sale, '开错客户');
    expect(rev.reversesId).toBe(ids.sale);
    expect(rev.amountCents).toBe(-4800);
    expect(await stock()).toBe(10);
    expect(await sum(boss.companyId, rev.id)).toBe(0);
    const orig = await docs.get(boss, ids.sale);
    expect(orig.status).toBe('reversed');
    expect(orig.reversedById).toBe(rev.id);
    await expect(docs.reverse(boss, ids.sale, '再来一次')).rejects.toThrow(/已过账/);
    await expect(docs.reverse(boss, rev.id, '红冲红冲')).rejects.toThrow(/不能再红冲/);
  });

  it('预收款、收款冲抵：冲抵不能超过预收余额；银行余额 = 登记余额 + 过账流水', async () => {
    const adv = await docs.createDraft(boss, { type: 'advance-receipt', date: day, partyId: ids.cust, bankAccountId: ids.bank, amountCents: 3000 });
    await docs.post(boss, adv.id);
    const over = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bank, amountCents: 100, offsetCents: 5000 });
    await expect(docs.post(boss, over.id)).rejects.toThrow(/预收款余额不够/);
    const ok = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bank, amountCents: 1200, offsetCents: 500 });
    await docs.post(boss, ok.id);
    const banks = await docs.bankBalances(boss);
    const b = banks.find((x) => x.id === ids.bank)!;
    expect(b.openingCents).toBe(100000);
    expect(b.movementCents).toBe(3000 + 1200);
    expect(b.balanceCents).toBe(104200);
  });

  it('转款、费用、其他收入、付款与预付冲抵', async () => {
    const t = await docs.createDraft(boss, { type: 'transfer', date: day, bankAccountId: ids.bank, toBankAccountId: ids.bank2, amountCents: 2000 });
    await docs.post(boss, t.id);
    await expect(docs.createDraft(boss, { type: 'transfer', date: day, bankAccountId: ids.bank, toBankAccountId: ids.bank, amountCents: 1 }).then((x) => docs.issue(boss, x.id))).rejects.toThrow(/不能是同一个账户/);
    const fy = await docs.createDraft(boss, { type: 'expense', date: day, bankAccountId: ids.bank2, lines: [{ feeItemId: ids.feeOut, qty: 1, unitPriceCents: 800 }] });
    await docs.post(boss, fy.id);
    const qs = await docs.createDraft(boss, { type: 'other-income', date: day, bankAccountId: ids.bank2, lines: [{ feeItemId: ids.feeIn, qty: 2, unitPriceCents: 150 }] });
    await docs.post(boss, qs.id);
    const yf = await docs.createDraft(boss, { type: 'prepayment', date: day, partyId: ids.supp, bankAccountId: ids.bank, amountCents: 1000 });
    await docs.post(boss, yf.id);
    const fk = await docs.createDraft(boss, { type: 'payment', date: day, partyId: ids.supp, bankAccountId: ids.bank, amountCents: 1500, offsetCents: 400 });
    await docs.post(boss, fk.id);
    const banks = await docs.bankBalances(boss);
    expect(banks.find((x) => x.id === ids.bank2)!.balanceCents).toBe(2000 - 800 + 300);
    expect(banks.find((x) => x.id === ids.bank)!.balanceCents).toBe(104200 - 2000 - 1000 - 1500);
    const ov = await docs.overview(boss, '2026-03');
    expect(ov.expenseCents).toBe(800);
    expect(ov.otherIncomeCents).toBe(300);
    expect(ov.prepaymentCents).toBe(600);
    expect(ov.payableCents).toBe(5000 - 1900); // 采购应付 5000，付款单冲应付 1500+400
    expect(await sum(boss.companyId)).toBe(0); // 全公司所有分录合计为 0
  });

  it('sourceKey 幂等：同一个来源只会有一张单据', async () => {
    const a = await docs.createDraft(boss, { type: 'expense', date: day, bankAccountId: ids.bank, lines: [{ feeItemId: ids.feeOut, qty: 1, unitPriceCents: 100 }] }, { sourceKey: 'flow:1:step:2' });
    const b = await docs.createDraft(boss, { type: 'expense', date: day, bankAccountId: ids.bank, lines: [{ feeItemId: ids.feeOut, qty: 1, unitPriceCents: 100 }] }, { sourceKey: 'flow:1:step:2' });
    expect(b.id).toBe(a.id);
  });

  it('开单结算：销售收了部分款剩下挂应收，预收冲抵；退货退款；采购付款；店铺作往来对象；手工单号', async () => {
    await docs.post(boss, (await docs.createDraft(boss, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 20, unitPriceCents: 500 }], bankAccountId: ids.bank, paidCents: 4000 })).id);
    const ov0 = await docs.overview(boss, day.slice(0, 7));
    const bank0 = (await docs.bankBalances(boss)).find((b) => b.id === ids.bank)!.balanceCents;
    // 销售 3 × 12 元 = 3600：收 1000，其中冲预收 600 在下面单独测，这里先收部分款
    const sale = await docs.post(boss, (await docs.createDraft(boss, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, bankAccountId: ids.bank, paidCents: 1000, handler: '小王', department: '销售部', docNo: 'XS-MANUAL-1', lines: [{ productId: ids.apple, qty: 3, unitPriceCents: 1200 }] })).id);
    expect(sale.docNo).toBe('XS-MANUAL-1');
    expect(sale.handler).toBe('小王');
    expect(await sum(boss.companyId, sale.id)).toBe(0);
    expect((await docs.bankBalances(boss)).find((b) => b.id === ids.bank)!.balanceCents).toBe(bank0 + 1000);
    expect((await docs.overview(boss, day.slice(0, 7))).receivableCents - ov0.receivableCents).toBe(2600);
    await expect(docs.createDraft(boss, { type: 'sale', date: day, partyId: ids.cust, docNo: 'XS-MANUAL-1' })).rejects.toThrow(/已经用过/);
    // 收了钱却没选账户：开立时拦住
    const noBank = await docs.createDraft(boss, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, paidCents: 100, lines: [{ productId: ids.apple, qty: 1, unitPriceCents: 1200 }] });
    await expect(docs.issue(boss, noBank.id)).rejects.toThrow(/收款账户/);
    // 红冲后银行和应收都回来
    await docs.reverse(boss, sale.id, '测试');
    expect((await docs.bankBalances(boss)).find((b) => b.id === ids.bank)!.balanceCents).toBe(bank0);
    // 网店销售：往来对象是店铺档案；选客户会被拒
    const web = await docs.post(boss, (await docs.createDraft(boss, { type: 'online-sale', date: day, partyId: ids.store, partyKind: 'store', warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 1, unitPriceCents: 1500 }] })).id);
    expect(web.docNo).toMatch(/^WDXS/);
    expect(web.partyKind).toBe('store');
    await expect(docs.createDraft(boss, { type: 'online-sale', date: day, partyId: ids.cust, partyKind: 'customer' })).rejects.toThrow(/不能选客户/);
    // 销售退货退款
    const ret = await docs.post(boss, (await docs.createDraft(boss, { type: 'sale-return', date: day, partyId: ids.cust, warehouseId: ids.wh, bankAccountId: ids.bank, paidCents: 500, lines: [{ productId: ids.apple, qty: 1, unitPriceCents: 1200 }] })).id);
    expect(ret.docNo).toMatch(/^XSTH/);
    expect(await sum(boss.companyId)).toBe(0);
  });

  it('费用单挂账、经营历程：财务审核后不能冲和改；改表头；复制为草稿；批量过账/删除', async () => {
    // 现金费用单（不选往来对象）没付清要被拦住；费用单选了供应商可以挂应付
    const cash = await docs.createDraft(boss, { type: 'expense', date: day, bankAccountId: ids.bank, paidCents: 100, lines: [{ feeItemId: ids.feeOut, qty: 1, unitPriceCents: 300 }] });
    await expect(docs.issue(boss, cash.id)).rejects.toThrow(/挂账|付清/);
    const credit = await docs.post(boss, (await docs.createDraft(boss, { type: 'expense', date: day, partyId: ids.supp, partyKind: 'supplier', bankAccountId: ids.bank, paidCents: 100, lines: [{ feeItemId: ids.feeOut, qty: 1, unitPriceCents: 300 }] })).id);
    expect(await sum(boss.companyId, credit.id)).toBe(0);
    expect(credit.entries.some((e) => e.kind === 'payable' && e.amountCents === -200)).toBe(true);
    // 财务审核
    const audited = await docs.audit(boss, credit.id, true);
    expect(audited.auditedAt).toBeTruthy();
    await expect(docs.reverse(boss, credit.id, '试试')).rejects.toThrow(/财务审核/);
    await expect(docs.editHeader(boss, credit.id, { handler: '小李' })).rejects.toThrow(/财务审核/);
    await docs.audit(boss, credit.id, false);
    const edited = await docs.editHeader(boss, credit.id, { date: '2026-03-11', handler: '小李', memo: '改过' });
    expect(edited.handler).toBe('小李');
    expect(edited.docDate).toBe('2026-03-11');
    expect(edited.entries.every((e) => String(e.entryDate).startsWith('2026-03-11'))).toBe(true);
    // 复制为草稿
    const copy = await docs.copyAsDraft(boss, credit.id);
    expect(copy.status).toBe('draft');
    expect(copy.docNo).not.toBe(credit.docNo);
    expect(copy.partyId).toBe(ids.supp);
    // 批量：一张能过账，一张缺信息；再批量删除草稿
    const bad = await docs.createDraft(boss, { type: 'sale', date: day });
    const res = await docs.batch(boss, 'post', [copy.id, bad.id]);
    expect(res.okCount).toBe(1);
    expect(res.results.find((r) => r.id === bad.id)?.error).toBeTruthy();
    const del = await docs.batch(boss, 'delete', [bad.id]);
    expect(del.okCount).toBe(1);
    const list = await docs.list(boss, { scope: 'history', page: 1, pageSize: 50, audited: 'no' });
    expect(list.rows.length).toBeGreaterThan(0);
    expect(list.amountCents).not.toBe(0);
  });

  it('转款多账户：两边合计必须相等，银行余额按各账户分别变动；费用行挂账对象，必须挂对象的费用项目要选对象', async () => {
    const b1 = (await docs.bankBalances(boss)).find((b) => b.id === ids.bank)!.balanceCents;
    const b2 = (await docs.bankBalances(boss)).find((b) => b.id === ids.bank2)!.balanceCents;
    const bad = await docs.createDraft(boss, { type: 'transfer', date: day, accounts: [{ role: 'out', bankAccountId: ids.bank, amountCents: 1000 }, { role: 'in', bankAccountId: ids.bank2, amountCents: 900 }] });
    await expect(docs.issue(boss, bad.id)).rejects.toThrow(/不相等/);
    const same = await docs.createDraft(boss, { type: 'transfer', date: day, accounts: [{ role: 'out', bankAccountId: ids.bank, amountCents: 100 }, { role: 'in', bankAccountId: ids.bank, amountCents: 100 }] });
    await expect(docs.issue(boss, same.id)).rejects.toThrow(/既转出又转入/);
    const bank3 = (await svc.create(boss, 'bank-accounts', { kind: 'company_card', accountName: '第三张卡', bank: '测试银行', accountNo: '6222000055556666' })).id;
    const ok = await docs.post(boss, (await docs.createDraft(boss, { type: 'transfer', date: day, accounts: [{ role: 'out', bankAccountId: ids.bank, amountCents: 1000 }, { role: 'in', bankAccountId: ids.bank2, amountCents: 600 }, { role: 'in', bankAccountId: bank3, amountCents: 400 }] })).id);
    expect(ok.amountCents).toBe(1000);
    expect(await sum(boss.companyId, ok.id)).toBe(0);
    const after = await docs.bankBalances(boss);
    expect(after.find((b) => b.id === ids.bank)!.balanceCents).toBe(b1 - 1000);
    expect(after.find((b) => b.id === ids.bank2)!.balanceCents).toBe(b2 + 600);
    expect(after.find((b) => b.id === bank3)!.balanceCents).toBe(400);
    expect(ok.accounts.length).toBe(3);
    await docs.reverse(boss, ok.id, '试试');
    expect((await docs.bankBalances(boss)).find((b) => b.id === bank3)!.balanceCents).toBe(0);
    // 费用行：必须挂对象
    const must = (await svc.create(boss, 'finance-fee-items', { code: 'T-MUST', name: '手机号月租', direction: 'expense', requiredObject: 'yes', defaultObject: '手机号' })).id;
    const phone = (await svc.create(boss, 'phones', { number: '13800138000', carrier: 'mobile' }).catch(() => null)) as { id: number } | null;
    const noObj = await docs.createDraft(boss, { type: 'expense', date: day, bankAccountId: ids.bank, lines: [{ feeItemId: must, qty: 1, unitPriceCents: 3000 }] });
    await expect(docs.issue(boss, noObj.id)).rejects.toThrow(/必须选挂账节点/);
    const withObj = await docs.createDraft(boss, { type: 'expense', date: day, bankAccountId: ids.bank, lines: [{ feeItemId: must, qty: 1, unitPriceCents: 3000, relatedNode: phone ? '手机号' : '公司', relatedId: phone?.id ?? null, relatedName: phone ? null : '总公司' }] });
    expect((await docs.issue(boss, withObj.id)).status).toBe('issued');
    await expect(docs.createDraft(boss, { type: 'expense', date: day, lines: [{ feeItemId: must, qty: 1, unitPriceCents: 1, relatedNode: '乱写' }] })).rejects.toThrow(/不认识/);
  });

  it('员工作为往来对象：同步员工名单（不重复）；费用单挂员工，没付的部分记在员工名下', async () => {
    const ep = new EmployeePartyService(ds, svc);
    const r1 = await ep.sync(boss);
    expect(r1.created).toBeGreaterThanOrEqual(1);
    expect((await ep.sync(boss)).created).toBe(0);
    const party = (await svc.list(boss, 'finance-employee-parties', { pageSize: 5 } as never)).items[0] as { id: number };
    const d = await docs.createDraft(boss, { type: 'expense', date: day, partyKind: 'employee', partyId: party.id, bankAccountId: ids.bank, paidCents: 0, lines: [{ feeItemId: ids.feeOut, qty: 1, unitPriceCents: 800 }] } as never);
    expect(d.partyName).toBeTruthy();
    await docs.issue(boss, d.id);
    const posted = await docs.post(boss, d.id);
    expect(posted.status).toBe('posted');
    expect(posted.partyKind).toBe('employee');
    // 收款单不允许选员工
    await expect(docs.createDraft(boss, { type: 'receipt', date: day, partyKind: 'employee', partyId: party.id, bankAccountId: ids.bank, amountCents: 100 } as never)).rejects.toThrow(/不能选/);
  });

  it('导入默认费用档案：类别树和费用项目，重复导入不重复', async () => {
    const fee = new FeeArchiveService(ds, svc);
    const r1 = await fee.seed(boss);
    expect(r1.categoriesCreated).toBeGreaterThan(100);
    expect(r1.itemsCreated).toBeGreaterThan(300);
    const r2 = await fee.seed(boss);
    expect(r2.categoriesCreated).toBe(0);
    expect(r2.itemsCreated).toBe(0);
    const list = await svc.list(boss, 'finance-fee-items', { keyword: '营业执照主证边框', page: 1, pageSize: 5 } as never);
    expect(list.items.some((i: { title: string }) => i.title === '营业执照主证边框')).toBe(true);
    await expect(fee.seed(clerk)).rejects.toThrow(/权限/);
  }, 120000);

  it('财务经营总览：趋势、店铺利润、台账；店铺资金取最新快照；没有成本权限看不到利润', async () => {
    const m = day.slice(0, 7);
    await svc.create(boss, 'store-daily-metrics', { storeId: ids.store, day, sales: 100000, refund: 5000, adCost: 10000, platformFee: 2000, purchaseCost: 30000, otherCost: 0 });
    await svc.create(boss, 'store-funds', { storeId: ids.store, snapshotDate: '2026-03-01', withdrawable: 1000, deposit: 5000 });
    await svc.create(boss, 'store-funds', { storeId: ids.store, snapshotDate: '2026-03-09', withdrawable: 2000, deposit: 5000, frozen: 300 });
    const o = await docs.overview(boss, m);
    expect(o.stores.find((x) => x.storeId === ids.store)).toMatchObject({ salesCents: 100000, profitCents: 53000 });
    expect(o.trend.length).toBeGreaterThan(0);
    expect(o.ledger.length).toBeGreaterThan(0);
    const funds = await docs.storeFunds(boss);
    expect(funds.find((x) => x.storeId === ids.store)).toMatchObject({ snapshotDate: '2026-03-09', withdrawableCents: 2000, frozenCents: 300 });
    const viewer: AuthUser = { ...clerk, permissions: { isCompanyAdmin: false, allow: ['finance.overview.view'], deny: [] } };
    const v = await docs.overview(viewer, m);
    expect(v.stores[0].profitCents).toBeNull();
    expect(v.trend.every((t) => t.profitCents === null)).toBe(true);
  });

  it('收款单按单据/按商品结算：不能超过未结余额，合计要等于本次结算金额，已被结算的单据不能红冲', async () => {
    const cust = (await svc.create(boss, 'finance-customers', { name: '按单结算客户' })).id;
    const mk = async (qty: number) => {
      const dr = await docs.createDraft(boss, { type: 'sale', date: day, partyId: cust, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty, unitPriceCents: 1000, unitCostCents: 500 }] });
      await docs.createDraft(boss, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty, unitPriceCents: 500 }] }).then((p) => docs.post(boss, p.id));
      return docs.post(boss, dr.id);
    };
    const a = await mk(10); // 10000 分
    const b = await mk(5); // 5000 分
    const open = await docs.openItems(boss, { dir: 'in', partyKind: 'customer', partyId: cust });
    expect(open.map((x) => x.outstandingCents).sort((p, q) => p - q)).toEqual([5000, 10000]);
    // 合计不等于本次结算金额
    await expect(docs.createDraft(boss, { type: 'receipt', date: day, partyId: cust, bankAccountId: ids.bank, amountCents: 12000, settleBy: 'doc', settlements: [{ sourceDocId: a.id, amountCents: 10000 }] }).then((d) => docs.post(boss, d.id))).rejects.toThrow(/要等于本次结算金额/);
    // 超过未结余额
    await expect(docs.createDraft(boss, { type: 'receipt', date: day, partyId: cust, bankAccountId: ids.bank, amountCents: 6000, settleBy: 'doc', settlements: [{ sourceDocId: b.id, amountCents: 6000 }] }).then((d) => docs.post(boss, d.id))).rejects.toThrow(/还没结算的只有/);
    // 按单据：一次收 12000，分给 a 10000 + b 2000
    const r1 = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: cust, bankAccountId: ids.bank, amountCents: 12000, settleBy: 'doc', settlements: [{ sourceDocId: a.id, amountCents: 10000 }, { sourceDocId: b.id, amountCents: 2000 }] });
    const p1 = await docs.post(boss, r1.id);
    expect(p1.settlements).toHaveLength(2);
    expect((await docs.get(boss, a.id)).settledBy[0].amountCents).toBe(10000);
    const left = await docs.openItems(boss, { dir: 'in', partyKind: 'customer', partyId: cust });
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: b.id, outstandingCents: 3000 });
    // 被结算的单据不能红冲
    await expect(docs.reverse(boss, a.id, '错了')).rejects.toThrow(/已经被/);
    // 按商品：b 的苹果还剩 3000
    await expect(docs.createDraft(boss, { type: 'receipt', date: day, partyId: cust, bankAccountId: ids.bank, amountCents: 4000, settleBy: 'product', settlements: [{ sourceDocId: b.id, productId: ids.apple, amountCents: 4000 }] }).then((d) => docs.post(boss, d.id))).rejects.toThrow(/还没结算的只有/);
    const r2 = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: cust, bankAccountId: ids.bank, amountCents: 3000, settleBy: 'product', settlements: [{ sourceDocId: b.id, productId: ids.apple, amountCents: 3000 }] });
    await docs.post(boss, r2.id);
    expect(await docs.openItems(boss, { dir: 'in', partyKind: 'customer', partyId: cust })).toHaveLength(0);
    // 明细表和未完全结算：按金额结算的收款单整张都没分配
    const r3 = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: cust, bankAccountId: ids.bank, amountCents: 100, settleBy: 'amount' });
    await docs.post(boss, r3.id);
    const detail = await docs.settlementDetail(boss, { partyId: cust });
    expect(detail.map((x) => x.amountCents).sort((x, y) => x - y)).toEqual([2000, 3000, 10000]);
    const un = await docs.unsettledReceipts(boss, { partyId: cust });
    expect(un).toHaveLength(1);
    expect(un[0]).toMatchObject({ docNo: r3.docNo, unallocatedCents: 100 });
    // 红冲收款单后，占用的余额放回来
    await docs.reverse(boss, r2.id, '重来');
    expect((await docs.openItems(boss, { dir: 'in', partyKind: 'customer', partyId: cust }))[0].outstandingCents).toBe(3000);
    // 付款单按单据结算采购入库
    const pin = await docs.createDraft(boss, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 4, unitPriceCents: 500 }] });
    await docs.post(boss, pin.id);
    const pay = await docs.createDraft(boss, { type: 'payment', date: day, partyId: ids.supp, bankAccountId: ids.bank, amountCents: 2000, settleBy: 'doc', settlements: [{ sourceDocId: pin.id, amountCents: 2000 }] });
    await expect(docs.post(boss, pay.id)).resolves.toMatchObject({ status: 'posted' });
    // 对象不对：付款单不能结算销售单
    await expect(docs.createDraft(boss, { type: 'payment', date: day, partyId: ids.supp, bankAccountId: ids.bank, amountCents: 100, settleBy: 'doc', settlements: [{ sourceDocId: b.id, amountCents: 100 }] }).then((d) => docs.post(boss, d.id))).rejects.toThrow(/不是可以付款结算|不是同一个/);
  });

  it('权限：没有过账权限不能过账；没有成本权限看不到成本；看不到的单据类型查不了', async () => {
    const dr = await docs.createDraft(clerk, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 1, unitPriceCents: 900 }] });
    await expect(docs.post(clerk, dr.id)).rejects.toThrow(/过账的权限/);
    await expect(docs.createDraft({ ...clerk, permissions: { isCompanyAdmin: false, allow: [], deny: [] } }, { type: 'sale', date: day })).rejects.toThrow(/权限/);
    const posted = await docs.post(boss, dr.id);
    const seen = await docs.get(clerk, posted.id);
    expect(seen.entries.some((e) => e.kind === 'cogs')).toBe(false);
    expect(seen.lines[0].unitCostCents).toBeNull();
    expect(seen.entries.find((e) => e.kind === 'inventory')!.amountCents).toBeNull();
    const ov = await docs.inventory(clerk, {}).catch((e: Error) => e.message);
    expect(String(ov)).toMatch(/权限/);
    await expect(docs.list(clerk, { scope: 'expense', page: 1, pageSize: 10 })).rejects.toThrow(/权限/);
    const hist = await docs.list(clerk, { scope: 'history', page: 1, pageSize: 50 });
    expect(hist.total).toBeGreaterThan(3);
    const drafts = await docs.list(clerk, { scope: 'drafts', page: 1, pageSize: 50 });
    expect(drafts.rows.every((r: { status: string }) => r.status === 'draft' || r.status === 'issued')).toBe(true);
  });
});
