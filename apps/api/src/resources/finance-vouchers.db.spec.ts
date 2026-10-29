/** 制单中心新增能力的真实数据库测试：整单优惠、费用单预付冲抵、往来余额、明细提示。RESOURCE_DB_TEST=1 TEST_DB_NAME=xxx npx jest finance-vouchers */
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

d('制单中心：优惠、预付冲抵、往来余额、行提示（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let docs: FinanceDocumentsService;
  let hints: FinanceVoucherHintsService;
  let boss: AuthUser;
  let clerk: AuthUser;
  let other: AuthUser;
  const ids: Record<string, number> = {};
  const day = '2026-03-10';
  const sum = async (docId: number) => Number((await ds.query('SELECT COALESCE(SUM(amount_cents),0) AS s FROM finance_entries WHERE document_id = ?', [docId]))[0].s);
  const kindSum = async (docId: number, kind: string) => Number((await ds.query('SELECT COALESCE(SUM(amount_cents),0) AS s FROM finance_entries WHERE document_id = ? AND kind = ?', [docId, kind]))[0].s);

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    docs = new FinanceDocumentsService(ds);
    hints = new FinanceVoucherHintsService(ds);
    const mk = async (name: string) => {
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `v${crypto.randomBytes(5).toString('hex')}`, name, status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `vc${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
      return { c, u };
    };
    const a = await mk('制单中心测试甲');
    boss = { id: a.u.id, companyId: a.c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    clerk = { id: a.u.id, companyId: a.c.id, name: '文员', permissions: { isCompanyAdmin: false, allow: ['finance.docs.create', 'finance.doc-sale.view'], deny: [] } };
    const b = await mk('制单中心测试乙');
    other = { id: b.u.id, companyId: b.c.id, name: '乙老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };

    const cat = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '制单测试类', code: 'VT' })).id;
    ids.apple = (await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '制单苹果', categoryId: cat, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 500, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' })).id;
    ids.pear = (await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '制单梨', categoryId: cat, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 300, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' })).id;
    ids.cust = (await svc.create(boss, 'finance-customers', { name: '赊销客户', creditLimit: 100000 })).id;
    ids.supp = (await svc.create(boss, 'finance-suppliers', { name: '预付供应商' })).id;
    ids.wh = (await svc.create(boss, 'finance-warehouses', { name: '制单仓' })).id;
    ids.fee = (await svc.create(boss, 'finance-fee-items', { name: '制单房租', direction: 'expense' })).id;
    ids.bank = (await svc.create(boss, 'bank-accounts', { kind: 'company_public', accountName: '制单公户', bank: '测试银行', accountNo: '6222000011119999', balance: 0 })).id;
    ids.otherCust = (await svc.create(other, 'finance-customers', { name: '乙公司客户' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('采购入库带优惠：应付按优惠后，库存成本被优惠摊低；红冲完全冲回，优惠额也取反', async () => {
    const draft = await docs.createDraft(boss, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, discountCents: 1000, lines: [{ productId: ids.apple, qty: 10, unitPriceCents: 500 }, { productId: ids.pear, qty: 10, unitPriceCents: 500 }] });
    expect(draft.amountCents).toBe(9000);
    expect(draft.discountCents).toBe(1000);
    const posted = await docs.post(boss, draft.id);
    expect(await sum(posted.id)).toBe(0);
    expect(await kindSum(posted.id, 'inventory')).toBe(9000);
    expect(await kindSum(posted.id, 'payable')).toBe(-9000);
    const inv = await docs.inventory(boss, {});
    expect(inv.find((x) => x.productId === ids.apple)?.amountCents).toBe(4500);
    const red = await docs.reverse(boss, posted.id, '测试红冲');
    expect(red.discountCents).toBe(-1000);
    expect(await kindSum(posted.id, 'inventory') + await kindSum(red.id, 'inventory')).toBe(0);
    expect((await docs.inventory(boss, {})).find((x) => x.productId === ids.apple)?.qty ?? 0).toBe(0);
  });

  it('销售带优惠：收入和应收按优惠后；优惠不能超过明细合计；非商品单据不能填优惠', async () => {
    await docs.post(boss, (await docs.createDraft(boss, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 20, unitPriceCents: 500 }] })).id);
    const s = await docs.post(boss, (await docs.createDraft(boss, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, discountCents: 300, lines: [{ productId: ids.apple, qty: 10, unitPriceCents: 1000 }] })).id);
    expect(s.amountCents).toBe(9700);
    expect(await kindSum(s.id, 'revenue')).toBe(-9700);
    expect(await kindSum(s.id, 'receivable')).toBe(9700);
    expect(await sum(s.id)).toBe(0);
    const copy = await docs.copyAsDraft(boss, s.id);
    expect(copy.discountCents).toBe(300);
    await expect(docs.issue(boss, (await docs.createDraft(boss, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, discountCents: 10000, lines: [{ productId: ids.apple, qty: 1, unitPriceCents: 10000 }] })).id)).rejects.toThrow(/优惠金额必须小于明细合计/);
    // 草稿里的非商品单据优惠不入库
    const e = await docs.createDraft(boss, { type: 'expense', date: day, partyId: ids.supp, discountCents: 5, lines: [{ feeItemId: ids.fee, qty: 1, unitPriceCents: 500 }] });
    expect(e.discountCents).toBe(0);
  });

  it('费用单用预付款结算：冲掉预付、剩余挂应付；预付余额不够过账被拒', async () => {
    await docs.post(boss, (await docs.createDraft(boss, { type: 'prepayment', date: day, partyId: ids.supp, bankAccountId: ids.bank, amountCents: 6000 })).id);
    const ok = await docs.post(boss, (await docs.createDraft(boss, { type: 'expense', date: day, partyId: ids.supp, partyKind: 'supplier', offsetCents: 4000, paidCents: 0, lines: [{ feeItemId: ids.fee, qty: 1, unitPriceCents: 10000, relatedNode: '公司', relatedName: '本公司' }] })).id);
    expect(await sum(ok.id)).toBe(0);
    expect(await kindSum(ok.id, 'prepayment')).toBe(-4000);
    expect(await kindSum(ok.id, 'payable')).toBe(-6000);
    const bal = await hints.partyBalance(boss, 'supplier', ids.supp);
    expect(bal.prepaymentCents).toBe(2000);
    await expect(docs.post(boss, (await docs.createDraft(boss, { type: 'expense', date: day, partyId: ids.supp, partyKind: 'supplier', offsetCents: 5000, paidCents: 0, lines: [{ feeItemId: ids.fee, qty: 1, unitPriceCents: 5000, relatedNode: '公司', relatedName: '本公司' }] })).id)).rejects.toThrow(/预付款余额不够/);
    // 不选往来对象就不能冲抵
    await expect(docs.issue(boss, (await docs.createDraft(boss, { type: 'expense', date: day, offsetCents: 100, paidCents: 400, bankAccountId: ids.bank, lines: [{ feeItemId: ids.fee, qty: 1, unitPriceCents: 500 }] })).id)).rejects.toThrow(/冲抵预付款要先选择/);
  });

  it('往来余额：应收、预收、赊销额度；别的公司的往来对象查不到', async () => {
    const b = await hints.partyBalance(boss, 'customer', ids.cust);
    expect(b.receivableCents).toBe(9700);
    expect(b.creditLimitCents).toBe(100000);
    expect(b.overLimit).toBe(false);
    await expect(hints.partyBalance(boss, 'customer', ids.otherCust)).rejects.toThrow(/不存在/);
    await expect(hints.partyBalance(boss, 'supplier', ids.cust)).rejects.toThrow(/不存在/);
    await expect(hints.partyBalance({ ...boss, permissions: { isCompanyAdmin: false, allow: [], deny: [] } }, 'customer', ids.cust)).rejects.toThrow(/没有制单权限/);
  });

  it('明细提示：账面库存人人有；最近进价要成本权限、最近售价要价格权限，没有就不返回字段；跨公司商品忽略', async () => {
    const full = await hints.lineHints(boss, [ids.apple, ids.otherCust], ids.wh);
    expect(full).toHaveLength(1);
    expect(full[0].stockQty).toBe(10);
    expect(full[0].lastPurchaseCents).toBe(500);
    expect(full[0].lastSaleCents).toBe(1000);
    const limited = await hints.lineHints(clerk, [ids.apple], ids.wh);
    expect(limited[0].stockQty).toBe(10);
    expect('lastPurchaseCents' in limited[0]).toBe(false);
    expect('lastSaleCents' in limited[0]).toBe(false);
    expect(await hints.lineHints(other, [ids.apple])).toEqual([]);
  });
});
