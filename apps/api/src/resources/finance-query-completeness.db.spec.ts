import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FinanceDocument, FinanceDocumentSettlement, FinanceEntry, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { FinanceDocumentsService } from './finance-documents.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('财务查询完整性：超过旧截断边界的合成历史事实', () => {
  let ds: DataSource, docs: FinanceDocumentsService, actor: AuthUser;
  const ids: Record<string, number> = {};
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true }).initialize();
    const token = randomBytes(5).toString('hex');
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `complete${token}`, name: '合成完整查询', status: 'active' }));
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: `complete${token}`, passwordHash: 'x', name: '合成管理员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    actor = { id: user.id, companyId: company.id, name: user.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const resources = buildServices(ds).resources;
    docs = new FinanceDocumentsService(ds);
    const category = await resources.create(actor, 'finance-categories', { archiveType: 'raw', name: '合成查询分类', code: 'COMPLETE' });
    ids.product = (await resources.create(actor, 'finance-products', { archiveType: 'raw', categoryId: category.id, name: '合成主档', specQty: 1, specUnit: 'KG', purchaseSpec: '千克', purchasePrice: 100, freight: 1, handlingFee: 1 })).id;
    ids.warehouse = (await resources.create(actor, 'finance-warehouses', { name: '合成全量仓' })).id;
    ids.supplier = (await resources.create(actor, 'finance-suppliers', { name: '合成供应商' })).id;
    ids.bank = (await resources.create(actor, 'bank-accounts', { kind: 'company_public', accountName: '合成全量账户', accountNo: '6222000099990001', bank: '合成银行', balance: 0 })).id;
    const draft = await docs.createDraft(actor, { type: 'purchase-in', date: '2026-03-01', partyId: ids.supplier, warehouseId: ids.warehouse, lines: [{ productId: ids.product, qty: 1, unitPriceCents: 100 }] });
    ids.document = (await docs.post(actor, draft.id)).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('超过1000行库存及1000/2000笔流水仍完整，主表与内层结存相等', async () => {
    // 批量构造历史账簿事实，单据归属使用上面实际过账的本公司单据。
    await ds.manager.insert(ResourceRecord, Array.from({ length: 1001 }, (_, index) => ({ companyId: actor.companyId, type: 'finance-products', title: `合成库存截断${index}`, status: 'active', data: { archiveType: 'raw', name: `合成库存截断${index}`, code: `SYNTHETIC-${index}`, specQty: 1, specUnit: 'KG' } })));
    const products = (await ds.manager.find(ResourceRecord, { where: { companyId: actor.companyId, type: 'finance-products' } })).filter(row => row.title.startsWith('合成库存截断'));
    const base = { companyId: actor.companyId, documentId: ids.document, entryDate: '2026-03-01' };
    await ds.manager.insert(FinanceEntry, [
      ...products.map(product => ({ ...base, kind: 'inventory', accountId: product.id, subId: ids.warehouse, qty: 1, amountCents: 1 })),
      ...Array.from({ length: 2001 }, () => ({ ...base, kind: 'inventory', accountId: ids.product, subId: ids.warehouse, qty: 1, amountCents: 1 })),
      ...Array.from({ length: 2001 }, () => ({ ...base, kind: 'bank', accountId: ids.bank, subId: 0, qty: null, amountCents: 1 })),
    ]);
    const inventory = await docs.inventory(actor, {});
    expect(inventory).toHaveLength(1002);
    const main = inventory.find(row => row.productId === ids.product)!;
    const stockLedger = await docs.inventoryLedger(actor, { productId: ids.product, warehouseId: ids.warehouse });
    expect(stockLedger.rows).toHaveLength(2002);
    expect(stockLedger.closingQty).toBe(2002);
    expect(stockLedger.closingQty).toBe(main.qty);
    expect(stockLedger.closingAmountCents).toBe(main.amountCents);
    const bankLedger = await docs.bankLedger(actor, ids.bank);
    expect(bankLedger.rows).toHaveLength(2001);
    expect(bankLedger).toMatchObject({ incomeCents: 2001, closingCents: 2001 });
    expect(bankLedger.closingCents).toBe((await docs.bankBalances(actor)).find(row => row.id === ids.bank)!.balanceCents);
    const noCost = { ...actor, permissions: { isCompanyAdmin: false, allow: ['finance.inventory.view'], deny: [] } };
    expect((await docs.inventory(noCost, {}))).toHaveLength(1002);
    expect((await docs.inventoryLedger(noCost, { productId: ids.product, warehouseId: ids.warehouse })).closingAmountCents).toBeNull();
  });

  it('超过5000条资金历史仍保留冷门店铺最新事实，补录旧日期不覆盖新快照，超过5000家店铺不截断', async () => {
    const resources = buildServices(ds).resources;
    const quiet = await resources.create(actor, 'stores', { name: '合成低频店铺', platform: 'pdd' });
    const busy = await resources.create(actor, 'stores', { name: '合成高频店铺', platform: 'pdd' });
    const snapshot = (storeId: number, snapshotDate: string, withdrawable: number) => ({ companyId: actor.companyId, type: 'store-funds', title: '合成资金快照', status: 'recorded', data: { storeId, snapshotDate, withdrawable, deposit: 0, frozen: 0, promotion: 0 } });
    await ds.manager.insert(ResourceRecord, snapshot(quiet.id, '2020-01-01', 111));
    await ds.manager.insert(ResourceRecord, Array.from({ length: 5001 }, (_, index) => snapshot(busy.id, new Date(Date.UTC(2010, 0, index + 1)).toISOString().slice(0, 10), index)));
    await ds.manager.insert(ResourceRecord, snapshot(busy.id, '2001-01-01', 999999));
    await ds.manager.insert(ResourceRecord, Array.from({ length: 5001 }, (_, index) => ({ companyId: actor.companyId, type: 'stores', title: `合成全量店铺${index}`, status: 'normal', data: { name: `合成全量店铺${index}`, platform: 'pdd' } })));
    const foreign = await ds.manager.save(Company, ds.manager.create(Company, { code: `foreign${randomBytes(5).toString('hex')}`, name: '合成他公司', status: 'active' }));
    // 即使旧JSON引用归属有误，也不能拿别公司的资金事实覆盖本公司店铺。
    await ds.manager.insert(ResourceRecord, { ...snapshot(quiet.id, '2099-01-01', 123456789), companyId: foreign.id });
    const funds = await docs.storeFunds(actor);
    expect(funds).toHaveLength(5003);
    expect(funds.find(row => row.storeId === quiet.id)).toMatchObject({ withdrawableCents: 111, snapshotDate: '2020-01-01' });
    expect(funds.find(row => row.storeId === busy.id)).toMatchObject({ withdrawableCents: 5000, snapshotDate: new Date(Date.UTC(2010, 0, 5001)).toISOString().slice(0, 10) });
    expect(await docs.storeFunds({ ...actor, companyId: foreign.id })).toEqual([]);
  });

  it('501张可结算原单、1001张收款及1000笔分配不截断，较早的未分配款仍能找出', async () => {
    const customer = await buildServices(ds).resources.create(actor, 'finance-customers', { name: '合成全量结算客户' });
    ids.customer = customer.id;
    const header = (docNo: string, docType: string, amountCents = 1, paidCents = 0) => ({ companyId: actor.companyId, docNo, docType, docDate: docType === 'sale' ? '2026-03-01' : '2026-03-02', partyId: docType === 'payment' ? ids.supplier : customer.id, partyKind: docType === 'payment' ? 'supplier' : 'customer', bankAccountId: docType === 'sale' ? null : ids.bank, status: 'posted' as const, amountCents, paidCents, offsetCents: 0, discountCents: 0, settlementMode: docType === 'sale' ? 'credit' : 'full', settleBy: docType === 'sale' ? null : 'doc', createdBy: actor.id });
    // 构造导入历史头部及结算事实；不依赖这些历史单据必须拥有商品明细才能按金额核销。
    await ds.manager.insert(FinanceDocument, Array.from({ length: 501 }, (_, index) => header(`SYNTHETIC-OPEN-${index}`, 'sale')));
    const source = await ds.manager.save(FinanceDocument, ds.manager.create(FinanceDocument, header('SYNTHETIC-ALLOCATED-SOURCE', 'sale', 1000)));
    await ds.manager.insert(FinanceDocument, Array.from({ length: 1001 }, (_, index) => header(`SYNTHETIC-RECEIPT-${index}`, 'receipt', 1, 1)));
    const receipts = (await ds.manager.find(FinanceDocument, { where: { companyId: actor.companyId, docType: 'receipt' }, order: { id: 'ASC' } }));
    ids.unallocatedReceipt = receipts[0].id;
    await ds.manager.insert(FinanceDocumentSettlement, receipts.slice(1).map(receipt => ({ companyId: actor.companyId, documentId: receipt.id, sourceDocumentId: source.id, productId: null, amountCents: 1 })));
    const payment = await ds.manager.save(FinanceDocument, ds.manager.create(FinanceDocument, header('SYNTHETIC-PAYMENT-CAP', 'payment', 2, 2)));
    ids.partialPayment = payment.id;
    await ds.manager.insert(FinanceDocumentSettlement, { companyId: actor.companyId, documentId: payment.id, sourceDocumentId: ids.document, productId: null, amountCents: 1 });
    const open = await docs.openItems(actor, { dir: 'in', partyKind: 'customer', partyId: customer.id });
    expect(open).toHaveLength(501);
    expect(open.some(row => row.docNo === 'SYNTHETIC-OPEN-500')).toBe(true);
    const unallocated = await docs.unsettledReceipts(actor, { docType: 'receipt' });
    expect(unallocated).toHaveLength(1);
    expect(unallocated[0]).toMatchObject({ id: receipts[0].id, unallocatedCents: 1 });
    const detail = await docs.settlementDetail(actor, { docType: 'receipt' });
    expect(detail).toHaveLength(1000);
    expect(detail.reduce((sum, row) => sum + row.amountCents, 0)).toBe(1000);
    expect(detail).toEqual(expect.arrayContaining([expect.objectContaining({ docId: receipts[1].id })]));

    const foreign = await ds.manager.save(Company, ds.manager.create(Company, { code: `settle${randomBytes(5).toString('hex')}`, name: '合成外公司结算', status: 'active' }));
    const foreignDoc = await ds.manager.save(FinanceDocument, ds.manager.create(FinanceDocument, { ...header('SYNTHETIC-FOREIGN-RECEIPT', 'receipt', 1, 1), companyId: foreign.id }));
    const oldestSale = await ds.manager.findOneByOrFail(FinanceDocument, { companyId: actor.companyId, docNo: 'SYNTHETIC-OPEN-0' });
    await ds.manager.insert(FinanceDocumentSettlement, [
      { companyId: actor.companyId, documentId: foreignDoc.id, sourceDocumentId: oldestSale.id, productId: null, amountCents: 1 },
      { companyId: foreign.id, documentId: receipts[0].id, sourceDocumentId: source.id, productId: null, amountCents: 1 },
      { companyId: actor.companyId, documentId: receipts[0].id, sourceDocumentId: foreignDoc.id, productId: null, amountCents: 1 },
    ]);
    expect(await docs.openItems(actor, { dir: 'in', partyKind: 'customer', partyId: customer.id })).toHaveLength(501);
    expect((await docs.unsettledReceipts(actor, { docType: 'receipt' }))[0]).toMatchObject({ id: receipts[0].id, unallocatedCents: 1 });
    expect(await docs.settlementDetail(actor, { docType: 'receipt' })).toHaveLength(1000);
  });

  it('两张结算查询按现有单据查看权限过滤类型，指定无权类型也拒绝', async () => {
    const receiptOnly = { ...actor, permissions: { isCompanyAdmin: false, allow: ['finance.doc-receipt.view'], deny: [] } };
    const paymentOnly = { ...actor, permissions: { isCompanyAdmin: false, allow: ['finance.doc-payment.view'], deny: [] } };
    expect((await docs.unsettledReceipts(receiptOnly, {})).map(row => row.id)).toEqual([ids.unallocatedReceipt]);
    expect(await docs.settlementDetail(receiptOnly, {})).toHaveLength(1000);
    expect((await docs.unsettledReceipts(paymentOnly, {})).map(row => row.id)).toEqual([ids.partialPayment]);
    expect(await docs.settlementDetail(paymentOnly, {})).toHaveLength(1);
    await expect(docs.settlementDetail(receiptOnly, { docType: 'payment' })).rejects.toThrow(/权限/);
    await expect(docs.unsettledReceipts(paymentOnly, { docType: 'receipt' })).rejects.toThrow(/权限/);
    const historyReader = { ...actor, permissions: { isCompanyAdmin: false, allow: ['finance.history.view'], deny: [] } };
    expect(await docs.settlementDetail(historyReader, {})).toHaveLength(1001);
  });
});
