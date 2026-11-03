import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FinanceEntry, ResourceRecord, User } from '../entities';
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
});
