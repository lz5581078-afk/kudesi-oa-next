/** 制单中心第二批的真实数据库测试：收付款优惠影响往来与财务费用、多账户收付款、转款手续费与确认入账、经手人员工。RESOURCE_DB_TEST=1 TEST_DB_NAME=xxx npx jest finance-voucher-batch2 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { FinanceDocumentsService } from './finance-documents.service';
import { FinanceVoucherHintsService } from './finance-voucher-hints.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('制单中心第二批（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let docs: FinanceDocumentsService;
  let hints: FinanceVoucherHintsService;
  let boss: AuthUser;
  let other: AuthUser;
  let confirmer: AuthUser;
  let maker: AuthUser;
  let staffId: number;
  let otherStaffId: number;
  const ids: Record<string, number> = {};
  const day = '2026-03-10';
  const sum = async (docId: number) => Number((await ds.query('SELECT COALESCE(SUM(amount_cents),0) AS s FROM finance_entries WHERE document_id = ?', [docId]))[0].s);
  const kindSum = async (docId: number, kind: string) => Number((await ds.query('SELECT COALESCE(SUM(amount_cents),0) AS s FROM finance_entries WHERE document_id = ? AND kind = ?', [docId, kind]))[0].s);
  const bankOf = async (docId: number, acct: number) => Number((await ds.query("SELECT COALESCE(SUM(amount_cents),0) AS s FROM finance_entries WHERE document_id = ? AND kind = 'bank' AND account_id = ?", [docId, acct]))[0].s);
  const balance = async (acct: number) => (await docs.bankBalances(boss)).find((b) => b.id === acct)!;
  const buy = async (qty: number, unit = 500) => docs.post(boss, (await docs.createDraft(boss, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty, unitPriceCents: unit }] })).id);

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    docs = new FinanceDocumentsService(ds);
    hints = new FinanceVoucherHintsService(ds);
    const mk = async (name: string) => {
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `b${crypto.randomBytes(5).toString('hex')}`, name, status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `b2${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
      const s = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `b2s${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '员工小王', isCompanyAdmin: false, status: 'active', mustChangePassword: false }));
      return { c, u, s };
    };
    const a = await mk('第二批测试甲');
    boss = { id: a.u.id, companyId: a.c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    staffId = a.s.id;
    confirmer = { id: a.s.id, companyId: a.c.id, name: '出纳', permissions: { isCompanyAdmin: false, allow: ['finance.docs.confirm-transfer', 'finance.history.view'], deny: [] } };
    maker = { id: a.s.id, companyId: a.c.id, name: '文员', permissions: { isCompanyAdmin: false, allow: ['finance.docs.create', 'finance.docs.post', 'finance.doc-transfer.view'], deny: [] } };
    const b = await mk('第二批测试乙');
    other = { id: b.u.id, companyId: b.c.id, name: '乙老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    otherStaffId = b.s.id;

    const cat = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '二批类', code: 'B2' })).id;
    ids.apple = (await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '二批苹果', categoryId: cat, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 500, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' })).id;
    ids.cust = (await svc.create(boss, 'finance-customers', { name: '二批客户' })).id;
    ids.supp = (await svc.create(boss, 'finance-suppliers', { name: '二批供应商' })).id;
    ids.wh = (await svc.create(boss, 'finance-warehouses', { name: '二批仓' })).id;
    const acct = (name: string, c: AuthUser = boss) => svc.create(c, 'bank-accounts', { kind: 'company_public', accountName: name, bank: '测试银行', accountNo: `62220000${crypto.randomInt(10000000, 99999999)}`, balance: 0 }).then((r) => r.id);
    ids.bankA = await acct('二批甲户');
    ids.bankB = await acct('二批乙户');
    ids.bankC = await acct('二批丙户');
    ids.otherBank = await acct('乙公司户', other);
    await buy(100);
  });
  afterAll(async () => { await ds?.destroy(); });

  describe('1 收款/付款优惠影响往来和财务费用', () => {
    it('收款优惠：冲减应收但不进银行，借记财务费用；往来余额、结算明细、财务经营口径一致；红冲完全冲回', async () => {
      const sale = await docs.post(boss, (await docs.createDraft(boss, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 10, unitPriceCents: 1000 }] })).id);
      expect((await hints.partyBalance(boss, 'customer', ids.cust)).receivableCents).toBe(10000);
      const before = await docs.overview(boss, 'all');
      const r = await docs.post(boss, (await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, discountCents: 1000, settleBy: 'doc', settlements: [{ sourceDocId: sale.id, amountCents: 10000 }], lines: [{ itemName: '客户回款', qty: 1, unitPriceCents: 9000 }] })).id);
      expect(r.amountCents).toBe(9000);
      expect(r.discountCents).toBe(1000);
      expect(await sum(r.id)).toBe(0);
      expect(await kindSum(r.id, 'bank')).toBe(9000);
      expect(await kindSum(r.id, 'finance_cost')).toBe(1000);
      expect(await kindSum(r.id, 'receivable')).toBe(-10000);
      expect((await hints.partyBalance(boss, 'customer', ids.cust)).receivableCents).toBe(0);
      expect((await docs.unsettledReceipts(boss, {})).find((x) => x.id === r.id)).toBeUndefined();
      const detail = await docs.settlementDetail(boss, {});
      expect((detail as Array<Record<string, unknown>>).filter((x) => x.docId === r.id).reduce((s, x) => s + Number(x.amountCents), 0)).toBe(10000);
      const after = await docs.overview(boss, 'all');
      expect(after.financeCostCents - before.financeCostCents).toBe(1000);
      expect(after.expenseCents).toBe(before.expenseCents);
      expect((after.netProfitCents as number) - (before.netProfitCents as number)).toBe(-1000);
      expect(after.ledger.some((x) => x.kind === 'finance_cost' && x.direction === 'out' && x.amountCents === 1000)).toBe(true);
      // 复制带优惠；红冲整体取反
      expect((await docs.copyAsDraft(boss, r.id)).discountCents).toBe(1000);
      const red = await docs.reverse(boss, r.id, '测试');
      expect(red.discountCents).toBe(-1000);
      expect(await kindSum(r.id, 'finance_cost') + await kindSum(red.id, 'finance_cost')).toBe(0);
      expect((await hints.partyBalance(boss, 'customer', ids.cust)).receivableCents).toBe(10000);
      expect((await docs.overview(boss, 'all')).financeCostCents).toBe(before.financeCostCents);
    });

    it('付款优惠：冲减应付，贷记财务费用（得到的折扣，利润增加）；按金额结算也能带优惠', async () => {
      const pin = await docs.post(boss, (await docs.createDraft(boss, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 20, unitPriceCents: 500 }] })).id);
      expect((await hints.partyBalance(boss, 'supplier', ids.supp)).payableCents).toBeGreaterThanOrEqual(10000);
      const base = (await hints.partyBalance(boss, 'supplier', ids.supp)).payableCents;
      const before = await docs.overview(boss, 'all');
      const p = await docs.post(boss, (await docs.createDraft(boss, { type: 'payment', date: day, partyId: ids.supp, bankAccountId: ids.bankA, discountCents: 300, lines: [{ itemName: '货款', qty: 1, unitPriceCents: 9700 }] })).id);
      expect(await sum(p.id)).toBe(0);
      expect(await kindSum(p.id, 'finance_cost')).toBe(-300);
      expect(await kindSum(p.id, 'payable')).toBe(10000);
      expect(await kindSum(p.id, 'bank')).toBe(-9700);
      expect((await hints.partyBalance(boss, 'supplier', ids.supp)).payableCents).toBe(base - 10000);
      const after = await docs.overview(boss, 'all');
      expect(after.financeCostCents - before.financeCostCents).toBe(-300);
      expect((after.netProfitCents as number) - (before.netProfitCents as number)).toBe(300);
      expect(after.ledger.some((x) => x.kind === 'finance_cost' && x.direction === 'in' && x.amountCents === 300)).toBe(true);
      void pin;
    });

    it('校验：优惠要先选往来对象；按单据结算的合计要包含优惠；其他单据的优惠仍然不存；老单据优惠默认 0', async () => {
      const sale = await docs.post(boss, (await docs.createDraft(boss, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 2, unitPriceCents: 1000 }] })).id);
      const noParty = await docs.createDraft(boss, { type: 'receipt', date: day, bankAccountId: ids.bankA, discountCents: 100, lines: [{ itemName: '回款', qty: 1, unitPriceCents: 500 }] });
      await expect(docs.issue(boss, noParty.id)).rejects.toThrow(/先选择/);
      const bad = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, discountCents: 100, settleBy: 'doc', settlements: [{ sourceDocId: sale.id, amountCents: 1900 }], lines: [{ itemName: '回款', qty: 1, unitPriceCents: 1900 }] });
      await expect(docs.issue(boss, bad.id)).rejects.toThrow(/结算单据合计/);
      const good = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, discountCents: 100, settleBy: 'doc', settlements: [{ sourceDocId: sale.id, amountCents: 2000 }], lines: [{ itemName: '回款', qty: 1, unitPriceCents: 1900 }] });
      await expect(docs.issue(boss, good.id)).resolves.toBeDefined();
      const adv = await docs.createDraft(boss, { type: 'advance-receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, discountCents: 100, amountCents: 500 });
      expect(adv.discountCents).toBe(0);
      const old = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, lines: [{ itemName: '回款', qty: 1, unitPriceCents: 500 }] });
      expect(old.discountCents).toBe(0);
      expect(old.feeCents).toBe(0);
      expect(old.transitStatus).toBeNull();
      expect(old.handlerId).toBeNull();
    });
  });

  describe('3 多账户收付款', () => {
    it('销售单分两个账户收款：每个账户一条银行分录，主表记第一个账户，余额、账本、红冲、复制都对', async () => {
      const a0 = (await balance(ids.bankA)).balanceCents, b0 = (await balance(ids.bankB)).balanceCents;
      const s = await docs.post(boss, (await docs.createDraft(boss, {
        type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, paidCents: 7000,
        accounts: [{ role: 'in', bankAccountId: ids.bankA, amountCents: 4000 }, { role: 'in', bankAccountId: ids.bankB, amountCents: 3000 }],
        lines: [{ productId: ids.apple, qty: 10, unitPriceCents: 1000 }],
      })).id);
      expect(s.bankAccountId).toBe(ids.bankA);
      expect(s.paidCents).toBe(7000);
      expect(s.accounts.map((x) => [x.bankAccountId, x.amountCents])).toEqual([[ids.bankA, 4000], [ids.bankB, 3000]]);
      expect(await sum(s.id)).toBe(0);
      expect(await bankOf(s.id, ids.bankA)).toBe(4000);
      expect(await bankOf(s.id, ids.bankB)).toBe(3000);
      expect(await kindSum(s.id, 'receivable')).toBe(3000);
      expect((await balance(ids.bankA)).balanceCents - a0).toBe(4000);
      expect((await balance(ids.bankB)).balanceCents - b0).toBe(3000);
      const led = await docs.bankLedger(boss, ids.bankB);
      expect((led.rows as Array<Record<string, unknown>>).some((x) => x.documentId === s.id && x.amountCents === 3000)).toBe(true);
      const list = await docs.list(boss, { scope: 'history', page: 1, pageSize: 50 });
      expect((list.rows as Array<Record<string, unknown>>).find((x) => x.id === s.id)?.acctCount).toBe(2);
      const copy = await docs.copyAsDraft(boss, s.id);
      expect(copy.accounts).toHaveLength(2);
      expect(copy.paidCents).toBe(7000);
      const red = await docs.reverse(boss, s.id, '测试');
      expect(await bankOf(red.id, ids.bankA)).toBe(-4000);
      expect((await balance(ids.bankA)).balanceCents).toBe(a0);
      expect((await balance(ids.bankB)).balanceCents).toBe(b0);
    });

    it('收款单、付款单、采购入库分账户；合计与金额不符、方向错、重复账户、别的公司账户一律拒绝', async () => {
      const r = await docs.post(boss, (await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, accounts: [{ role: 'in', bankAccountId: ids.bankA, amountCents: 600 }, { role: 'in', bankAccountId: ids.bankC, amountCents: 400 }], lines: [{ itemName: '回款', qty: 1, unitPriceCents: 1000 }] })).id);
      expect(await kindSum(r.id, 'bank')).toBe(1000);
      expect(await sum(r.id)).toBe(0);
      const p = await docs.post(boss, (await docs.createDraft(boss, { type: 'payment', date: day, partyId: ids.supp, accounts: [{ role: 'out', bankAccountId: ids.bankA, amountCents: 100 }, { role: 'out', bankAccountId: ids.bankB, amountCents: 200 }], lines: [{ itemName: '货款', qty: 1, unitPriceCents: 300 }] })).id);
      expect(await bankOf(p.id, ids.bankB)).toBe(-200);
      const pi = await docs.post(boss, (await docs.createDraft(boss, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, accounts: [{ role: 'out', bankAccountId: ids.bankA, amountCents: 500 }, { role: 'out', bankAccountId: ids.bankB, amountCents: 500 }], lines: [{ productId: ids.apple, qty: 4, unitPriceCents: 500 }] })).id);
      expect(pi.paidCents).toBe(1000);
      expect(await kindSum(pi.id, 'payable')).toBe(-1000);
      const mk = (over: object) => docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, lines: [{ itemName: '回款', qty: 1, unitPriceCents: 1000 }], ...over } as never);
      await expect(docs.issue(boss, (await mk({ accounts: [{ role: 'in', bankAccountId: ids.bankA, amountCents: 600 }, { role: 'in', bankAccountId: ids.bankB, amountCents: 300 }] })).id)).rejects.toThrow(/各账户金额合计/);
      await expect(docs.issue(boss, (await mk({ accounts: [{ role: 'out', bankAccountId: ids.bankA, amountCents: 1000 }] })).id)).rejects.toThrow(/方向不对/);
      await expect(docs.issue(boss, (await mk({ accounts: [{ role: 'in', bankAccountId: ids.bankA, amountCents: 500 }, { role: 'in', bankAccountId: ids.bankA, amountCents: 500 }] })).id)).rejects.toThrow(/不能重复/);
      await expect(mk({ accounts: [{ role: 'in', bankAccountId: ids.otherBank, amountCents: 1000 }] })).rejects.toThrow(/不存在/);
      // 实收和各账户合计不一致
      await expect(docs.createDraft(boss, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, paidCents: 900, accounts: [{ role: 'in', bankAccountId: ids.bankA, amountCents: 500 }], lines: [{ productId: ids.apple, qty: 1, unitPriceCents: 1000 }] })).rejects.toThrow(/各账户金额合计/);
      // 转款单和店铺提现不走这条路
      await expect(docs.createDraft(boss, { type: 'withdrawal', date: day, storeId: 1, refNo: 'x', accounts: [{ role: 'in', bankAccountId: ids.bankA, amountCents: 100 }], amountCents: 100 } as never)).rejects.toThrow();
    });

    it('单账户老写法完全不变；草稿改成单账户后分账户行被清掉', async () => {
      const d1 = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, accounts: [{ role: 'in', bankAccountId: ids.bankA, amountCents: 500 }, { role: 'in', bankAccountId: ids.bankB, amountCents: 500 }], lines: [{ itemName: '回款', qty: 1, unitPriceCents: 1000 }] });
      expect(d1.accounts).toHaveLength(2);
      const d2 = await docs.updateDraft(boss, d1.id, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankC, lines: [{ itemName: '回款', qty: 1, unitPriceCents: 1000 }] });
      expect(d2.accounts).toHaveLength(0);
      expect(d2.bankAccountId).toBe(ids.bankC);
      const posted = await docs.post(boss, d2.id);
      expect(await bankOf(posted.id, ids.bankC)).toBe(1000);
    });
  });

  describe('4 转款手续费与确认入账', () => {
    const transfer = (over: object, user = boss) => docs.createDraft(user, { type: 'transfer', date: day, accounts: [{ role: 'out', bankAccountId: ids.bankA, amountCents: 5000 }, { role: 'in', bankAccountId: ids.bankB, amountCents: 5000 }], lines: [{ itemName: '资金调拨', qty: 1, unitPriceCents: 5000 }], ...over } as never);

    it('转出方承担手续费：转出账户多扣手续费，财务费用借记；总额只少手续费', async () => {
      const a0 = (await balance(ids.bankA)).balanceCents, b0 = (await balance(ids.bankB)).balanceCents;
      const before = await docs.overview(boss, 'all');
      const t = await docs.post(boss, (await transfer({ feeCents: 30, feeBearer: 'out' })).id);
      expect(t.feeCents).toBe(30);
      expect(await sum(t.id)).toBe(0);
      expect((await balance(ids.bankA)).balanceCents - a0).toBe(-5030);
      expect((await balance(ids.bankB)).balanceCents - b0).toBe(5000);
      expect(await kindSum(t.id, 'finance_cost')).toBe(30);
      expect(((await docs.overview(boss, 'all')).financeCostCents) - before.financeCostCents).toBe(30);
    });

    it('转入方承担手续费：到账账户少收手续费', async () => {
      const b0 = (await balance(ids.bankB)).balanceCents;
      const t = await docs.post(boss, (await transfer({ feeCents: 20, feeBearer: 'in' })).id);
      expect((await balance(ids.bankB)).balanceCents - b0).toBe(4980);
      expect(await bankOf(t.id, ids.bankB)).toBe(4980);
    });

    it('手续费必须选承担方；手续费只有转款单能填', async () => {
      await expect(docs.issue(boss, (await transfer({ feeCents: 20 })).id)).rejects.toThrow(/承担/);
      const e = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, feeCents: 5, feeBearer: 'out', lines: [{ itemName: '回款', qty: 1, unitPriceCents: 100 }] } as never);
      expect(e.feeCents).toBe(0);
      await expect(docs.issue(boss, (await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, inTransit: true, lines: [{ itemName: '回款', qty: 1, unitPriceCents: 100 }] } as never)).id)).resolves.toBeDefined();
    });

    it('在途转款：过账只扣转出账户，在途金额在现金银行可见；确认入账后转入账户才增加；重复确认、无权限、跨公司都被拒；写事件和审计', async () => {
      const a0 = (await balance(ids.bankA)).balanceCents, c0 = (await balance(ids.bankC)).balanceCents;
      const t = await docs.post(boss, (await transfer({ inTransit: true, feeCents: 10, feeBearer: 'in', accounts: [{ role: 'out', bankAccountId: ids.bankA, amountCents: 2000 }, { role: 'in', bankAccountId: ids.bankC, amountCents: 2000 }], lines: [{ itemName: '调拨', qty: 1, unitPriceCents: 2000 }] })).id);
      expect(t.transitStatus).toBe('pending');
      expect(await sum(t.id)).toBe(0);
      expect((await balance(ids.bankA)).balanceCents - a0).toBe(-2000);
      const mid = await balance(ids.bankC);
      expect(mid.balanceCents - c0).toBe(0);
      expect(mid.inTransitCents).toBe(2000);
      expect(await kindSum(t.id, 'finance_cost')).toBe(0); // 转入方承担的手续费到账时才扣
      expect(((await docs.list(boss, { scope: 'history', transit: 'pending', page: 1, pageSize: 50 })).rows as Array<Record<string, unknown>>).map((x) => x.id)).toContain(t.id);
      await expect(docs.audit(boss, t.id, true)).rejects.toThrow(/还在途中/);
      // 权限：制单人没有确认权限；跨公司按不存在
      await expect(docs.confirmTransfer(maker, t.id)).rejects.toThrow(/没有确认转款入账的权限/);
      await expect(docs.confirmTransfer({ ...other, permissions: { isCompanyAdmin: true, allow: [], deny: [] } }, t.id)).rejects.toThrow(/不存在/);
      await expect(docs.confirmTransfer(confirmer, t.id, { date: '2026-03-01' })).rejects.toThrow(/不能早于/);
      const ok = await docs.confirmTransfer(confirmer, t.id, { note: '银行回单已核对' });
      expect(ok.transitStatus).toBe('confirmed');
      expect(ok.confirmedBy).toBe(confirmer.id);
      expect(ok.events.some((e) => e.action === 'confirm-transfer')).toBe(true);
      expect(await sum(t.id)).toBe(0);
      const done = await balance(ids.bankC);
      expect(done.inTransitCents).toBe(0);
      expect(done.balanceCents - c0).toBe(1990);
      expect(await kindSum(t.id, 'finance_cost')).toBe(10);
      const audit = await ds.query("SELECT detail FROM audit_logs WHERE company_id = ? AND action = 'finance.confirm-transfer' AND resource_id = ?", [boss.companyId, String(t.id)]);
      expect(audit).toHaveLength(1);
      await expect(docs.confirmTransfer(confirmer, t.id)).rejects.toThrow(/已经确认/);
      // 已确认的转款不能改日期；红冲把确认的分录一并冲回
      await expect(docs.editHeader(boss, t.id, { date: '2026-03-12' })).rejects.toThrow(/已确认入账/);
      const red = await docs.reverse(boss, t.id, '测试');
      expect(await sum(red.id)).toBe(0);
      expect((await balance(ids.bankC)).balanceCents).toBe(c0);
      expect((await balance(ids.bankA)).balanceCents).toBe(a0);
      await expect(docs.confirmTransfer(confirmer, red.id)).rejects.toThrow();
    });

    it('在途转款还没确认就红冲：在途冲掉，之后不能确认；非在途转款、非转款单不能确认；复制保留在途登记', async () => {
      const c0 = (await balance(ids.bankC)).balanceCents;
      const t = await docs.post(boss, (await transfer({ inTransit: true, accounts: [{ role: 'out', bankAccountId: ids.bankA, amountCents: 700 }, { role: 'in', bankAccountId: ids.bankC, amountCents: 700 }], lines: [{ itemName: '调拨', qty: 1, unitPriceCents: 700 }] })).id);
      expect((await balance(ids.bankC)).inTransitCents).toBe(700);
      const cp = await docs.copyAsDraft(boss, t.id);
      expect(cp.transitStatus).toBe('pending');
      await docs.reverse(boss, t.id, '测试');
      expect((await balance(ids.bankC)).inTransitCents).toBe(0);
      await expect(docs.confirmTransfer(confirmer, t.id)).rejects.toThrow(/已经红冲/);
      const plain = await docs.post(boss, (await transfer({})).id);
      await expect(docs.confirmTransfer(confirmer, plain.id)).rejects.toThrow(/不是在途转款/);
      const draft = await transfer({ inTransit: true });
      await expect(docs.confirmTransfer(confirmer, draft.id)).rejects.toThrow(/先过账/);
      const r = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, lines: [{ itemName: '回款', qty: 1, unitPriceCents: 100 }] });
      await expect(docs.confirmTransfer(confirmer, r.id)).rejects.toThrow(/只有转款单/);
      expect((await balance(ids.bankC)).balanceCents).toBe(c0);
    });

    it('流程引擎可在自己的事务里调用确认入账（同成同败）', async () => {
      const t = await docs.post(boss, (await transfer({ inTransit: true, accounts: [{ role: 'out', bankAccountId: ids.bankA, amountCents: 100 }, { role: 'in', bankAccountId: ids.bankC, amountCents: 100 }], lines: [{ itemName: '调拨', qty: 1, unitPriceCents: 100 }] })).id);
      await expect(ds.transaction(async (em) => { await docs.confirmTransfer(confirmer, t.id, {}, em); throw new Error('流程后续步骤失败'); })).rejects.toThrow(/流程后续/);
      expect((await docs.get(boss, t.id)).transitStatus).toBe('pending');
      await ds.transaction((em) => docs.confirmTransfer(confirmer, t.id, {}, em));
      expect((await docs.get(boss, t.id)).transitStatus).toBe('confirmed');
    });
  });

  describe('5 经手人员工选择器', () => {
    it('保存员工 id 并显示姓名，员工改名后跟着变；跨公司员工被拒；老数据文字照常显示', async () => {
      const d1 = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, handlerId: staffId, handler: '随便写', lines: [{ itemName: '回款', qty: 1, unitPriceCents: 100 }] });
      expect(d1.handlerId).toBe(staffId);
      expect(d1.handler).toBe('员工小王');
      await ds.query('UPDATE users SET name = ? WHERE id = ?', ['员工小王改名', staffId]);
      expect((await docs.get(boss, d1.id)).handler).toBe('员工小王改名');
      expect(((await docs.list(boss, { scope: 'drafts', page: 1, pageSize: 50 })).rows as Array<Record<string, unknown>>).find((x) => x.id === d1.id)?.handler).toBe('员工小王改名');
      await expect(docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, handlerId: otherStaffId, lines: [{ itemName: '回款', qty: 1, unitPriceCents: 100 }] })).rejects.toThrow(/不是本公司/);
      const legacy = await docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, handler: '老张（外聘）', lines: [{ itemName: '回款', qty: 1, unitPriceCents: 100 }] });
      expect(legacy.handlerId).toBeNull();
      expect(legacy.handler).toBe('老张（外聘）');
      const upd = await docs.updateDraft(boss, legacy.id, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, handler: '老张（外聘）', lines: [{ itemName: '回款', qty: 1, unitPriceCents: 100 }] });
      expect(upd.handler).toBe('老张（外聘）');
      const posted = await docs.post(boss, d1.id);
      const edited = await docs.editHeader(boss, posted.id, { handlerId: staffId });
      expect(edited.handler).toBe('员工小王改名');
      await expect(docs.editHeader(boss, posted.id, { handlerId: otherStaffId })).rejects.toThrow(/不是本公司/);
      const cleared = await docs.editHeader(boss, posted.id, { handlerId: null, handler: '改回文字' });
      expect(cleared.handlerId).toBeNull();
      expect(cleared.handler).toBe('改回文字');
      // 停用员工不能新选
      await ds.query("UPDATE users SET status = 'disabled' WHERE id = ?", [staffId]);
      await expect(docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankA, handlerId: staffId, lines: [{ itemName: '回款', qty: 1, unitPriceCents: 100 }] })).rejects.toThrow(/已停用/);
      await ds.query("UPDATE users SET status = 'active' WHERE id = ?", [staffId]);
    });
  });
});
