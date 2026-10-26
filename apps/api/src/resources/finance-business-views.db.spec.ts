/** 财务经营 / 经营历程 / 现金银行查询 / 库存查询 / 银行流水号防重复 的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_d npx jest finance-business-views */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { FinanceDocumentsService } from './finance-documents.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('财务查询页面（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let docs: FinanceDocumentsService;
  let boss: AuthUser, other: AuthUser, noHistory: AuthUser, noCost: AuthUser, userB: AuthUser;
  const ids: Record<string, number> = {};
  const day = '2026-03-10';

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    docs = new FinanceDocumentsService(ds);
    const mk = async (code: string) => {
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `${code}${crypto.randomBytes(5).toString('hex')}`, name: '查询测试', status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
      return { c, u, au: { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser };
    };
    const a = await mk('v'); boss = a.au;
    other = (await mk('w')).au;
    const second = await ds.manager.save(User, ds.manager.create(User, { companyId: a.c.id, account: 'b', passwordHash: 'x', name: '会计B', isCompanyAdmin: false, status: 'active', mustChangePassword: false }));
    const viewPerms = ['finance.overview.view', 'finance.history.view', 'finance.cash-bank.view', 'finance.inventory.view'];
    noHistory = { id: second.id, companyId: a.c.id, name: '无历史权限', permissions: { isCompanyAdmin: false, allow: ['finance.overview.view', 'finance.cash-bank.view'], deny: [] } };
    noCost = { id: second.id, companyId: a.c.id, name: '无成本权限', permissions: { isCompanyAdmin: false, allow: viewPerms, deny: [] } };
    userB = { id: second.id, companyId: a.c.id, name: '会计B', permissions: { isCompanyAdmin: false, allow: viewPerms, deny: [] } };

    const cat = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '查询测试类', code: 'QV' })).id;
    ids.apple = (await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '查询苹果', categoryId: cat, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 500, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' })).id;
    ids.pear = (await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '查询梨', categoryId: cat, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 300, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' })).id;
    ids.cust = (await svc.create(boss, 'finance-customers', { name: '老客户' })).id;
    ids.supp = (await svc.create(boss, 'finance-suppliers', { name: '果园' })).id;
    ids.wh = (await svc.create(boss, 'finance-warehouses', { name: '一号仓' })).id;
    ids.feeOut = (await svc.create(boss, 'finance-fee-items', { name: '房租', direction: 'expense' })).id;
    ids.lic = (await svc.create(boss, 'licenses', { category: 'operation', companyName: '主体甲公司', creditCode: `V-${crypto.randomBytes(5).toString('hex')}`, legalPerson: '王' })).id;
    ids.store = (await svc.create(boss, 'stores', { name: '查询店A', platform: 'pdd', licenseId: ids.lic })).id;
    ids.store2 = (await svc.create(boss, 'stores', { name: '查询店B', platform: 'taobao' })).id;
    ids.bankStore = (await svc.create(boss, 'bank-accounts', { kind: 'store_public', accountName: '店铺公户', bank: '测试银行', accountNo: '6222000011110001', balance: 1000, storeId: ids.store, licenseId: ids.lic })).id;
    ids.bankCo = (await svc.create(boss, 'bank-accounts', { kind: 'company_public', accountName: '公司公户', bank: '测试银行', accountNo: '6222000011110002', balance: 100000 })).id;
    ids.bankFree = (await svc.create(boss, 'bank-accounts', { kind: 'cashier_account', accountName: '出纳', bank: '测试银行', accountNo: '6222000011110003' })).id;
    // 入库 10 个苹果、5 个梨；卖光梨
    await docs.post(boss, (await docs.createDraft(boss, { type: 'purchase-in', date: day, partyId: ids.supp, warehouseId: ids.wh, lines: [{ productId: ids.apple, qty: 10, unitPriceCents: 500 }, { productId: ids.pear, qty: 5, unitPriceCents: 300 }] })).id);
    await docs.post(boss, (await docs.createDraft(boss, { type: 'sale', date: day, partyId: ids.cust, warehouseId: ids.wh, lines: [{ productId: ids.pear, qty: 5, unitPriceCents: 900 }] })).id);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('经营历程：按收支方向筛选，汇总条是收入/支出/净额，每行带来源；没有权限被拒', async () => {
    const exp = await docs.createDraft(boss, { type: 'expense', date: day, bankAccountId: ids.bankCo, lines: [{ feeItemId: ids.feeOut, qty: 1, unitPriceCents: 7000 }] });
    await docs.post(boss, exp.id);
    await ds.query("UPDATE finance_documents SET source_key = 'flow:999:pay' WHERE id = ?", [exp.id]); // 假装是流程自动记账的
    const all = await docs.list(boss, { scope: 'history', page: 1, pageSize: 50 });
    expect(all.incomeCents).toBe(4500); // 销售 5 × 900
    expect(all.expenseCents).toBe(6500 + 7000); // 采购入库 10×500+5×300，加上费用 7000
    const outs = await docs.list(boss, { scope: 'history', direction: 'out', page: 1, pageSize: 50 });
    expect(outs.rows.every((r: { direction: string }) => r.direction === 'out')).toBe(true);
    expect(outs.rows.map((r: { docType: string }) => r.docType).sort()).toEqual(['expense', 'purchase-in']);
    expect(outs.incomeCents).toBe(0);
    expect(outs.expenseCents).toBe(13500);
    const ins = await docs.list(boss, { scope: 'history', direction: 'in', page: 1, pageSize: 50 });
    expect(ins.rows.map((r: { docType: string }) => r.docType)).toEqual(['sale']);
    expect(ins.incomeCents - ins.expenseCents).toBe(4500);
    const bySource = Object.fromEntries(outs.rows.map((r: { docType: string; source: string }) => [r.docType, r.source]));
    expect(bySource).toEqual({ expense: '流程自动记账', 'purchase-in': '手工制单' });
    await expect(docs.list(noHistory, { scope: 'history', page: 1, pageSize: 10 })).rejects.toThrow(/权限/);
    await expect(docs.list(other, { scope: 'history', page: 1, pageSize: 50 }).then((r) => r.total)).resolves.toBe(0); // 别的公司看不到
  });

  it('财务经营：全部时间的趋势按月汇总；店铺利润带主体；台账带店铺和来源', async () => {
    await svc.create(boss, 'store-daily-metrics', { storeId: ids.store, day, sales: 10000, refund: 0, adCost: 1000, platformFee: 0, purchaseCost: 3000, otherCost: 0 });
    // 提现单：台账里没有，但店铺来源要能识别；其他收入单带店铺（往来对象是店铺）
    const feeIn = (await svc.create(boss, 'finance-fee-items', { name: '店铺返点', direction: 'income' })).id;
    const oi = await docs.createDraft(boss, { type: 'other-income', date: day, partyId: ids.store, partyKind: 'store', bankAccountId: ids.bankCo, lines: [{ feeItemId: feeIn, qty: 1, unitPriceCents: 800 }] });
    await docs.post(boss, oi.id);
    const month = await docs.overview(boss, '2026-03');
    expect(month.trendBy).toBe('day');
    expect(month.stores[0]).toMatchObject({ name: '查询店A', licenseName: '主体甲公司', salesCents: 10000, profitCents: 6000 });
    const led = month.ledger.find((l: { docType: string }) => l.docType === 'other-income')!;
    expect(led).toMatchObject({ storeName: '查询店A', source: '手工制单' });
    await ds.query("UPDATE finance_documents SET source_key = 'flow:1:pay' WHERE id = ?", [oi.id]);
    expect((await docs.overview(boss, '2026-03')).ledger.find((l: { docType: string }) => l.docType === 'other-income')!.source).toBe('流程自动记账');
    // 其他月份没有数据，全部时间能看到
    const empty = await docs.overview(boss, '2025-01');
    expect(empty.revenueCents).toBe(0);
    expect(empty.stores).toHaveLength(0);
    const all = await docs.overview(boss, 'all');
    expect(all.month).toBe('all');
    expect(all.trendBy).toBe('month');
    expect(all.trend.map((t: { date: string }) => t.date)).toEqual(['2026-03']);
    expect(all.revenueCents).toBe(4500);
    expect(all.stores).toHaveLength(1);
    // 没有成本权限：利润为空
    const hidden = await docs.overview(noCost, 'all');
    expect(hidden.netProfitCents).toBeNull();
    expect(hidden.stores[0].profitCents).toBeNull();
    await expect(docs.overview({ ...noCost, permissions: { isCompanyAdmin: false, allow: [], deny: [] } }, 'all')).rejects.toThrow(/权限/);
  });

  it('库存查询：缺货筛选只留数量 ≤ 0 的行；库存正常只留 > 0 的行', async () => {
    const all = await docs.inventory(boss, {});
    expect(all.map((r) => r.productName)).toEqual(['查询苹果']); // 梨数量为 0 且金额为 0，不筛选时不显示
    const out = await docs.inventory(boss, { stockStatus: 'out' });
    expect(out.map((r) => r.productName)).toEqual(['查询梨']);
    expect(out[0].qty).toBe(0);
    const normal = await docs.inventory(boss, { stockStatus: 'normal' });
    expect(normal.map((r) => r.productName)).toEqual(['查询苹果']);
    await expect(docs.inventory({ ...noCost, permissions: { isCompanyAdmin: false, allow: [], deny: [] } }, { stockStatus: 'out' })).rejects.toThrow(/权限/);
  });

  it('现金银行：账户带主体、关联店铺（资料里选的 + 手动关联）和最后更新时间；店铺资金带平台，没有快照用店铺档案里的资金', async () => {
    const banks = await docs.bankBalances(boss);
    const st = banks.find((b) => b.id === ids.bankStore)!;
    expect(st).toMatchObject({ kind: 'store_public', licenseName: '主体甲公司', storeIds: [ids.store], storeNames: ['查询店A'], balanceCents: 1000 });
    expect(new Date(st.updatedAt!).getTime()).toBeGreaterThan(Date.now() - 3600_000);
    // 手动关联：公司公户 ↔ 店铺B
    await svc.addManualLink(boss, 'bank-accounts', ids.bankCo, 'stores', ids.store2, () => true);
    expect((await docs.bankBalances(boss)).find((b) => b.id === ids.bankCo)!.storeNames).toEqual(['查询店B']);
    await svc.update(boss, 'stores', ids.store2, { goodsFund: 12345, deposit: 500 });
    await svc.create(boss, 'store-funds', { storeId: ids.store, snapshotDate: day, withdrawable: 7777, deposit: 100, frozen: 0, promotion: 50 });
    const funds = await docs.storeFunds(boss);
    const a = funds.find((f) => f.storeId === ids.store)!, b = funds.find((f) => f.storeId === ids.store2)!;
    expect(a).toMatchObject({ platformLabel: '拼多多', withdrawableCents: 7777, snapshotDate: day });
    expect(b).toMatchObject({ platformLabel: '淘宝', withdrawableCents: 12345, depositCents: 500, snapshotDate: '' });
    expect(b.updatedAt).not.toBeNull();
    expect(funds[0].storeId).toBe(ids.store2); // 可提现从多到少
  });

  it('重点账户：每个人自己标记，互不影响；只能标本公司的银行账户；没有权限被拒', async () => {
    expect(await docs.keyAccounts(boss)).toEqual([]);
    expect(await docs.setKeyAccount(boss, ids.bankCo, true)).toEqual([ids.bankCo]);
    expect(await docs.setKeyAccount(boss, ids.bankCo, true)).toEqual([ids.bankCo]); // 重复标记不报错
    await docs.setKeyAccount(boss, ids.bankStore, true);
    expect(await docs.keyAccounts(userB)).toEqual([]); // 另一个人看不到我的标记
    await docs.setKeyAccount(userB, ids.bankFree, true);
    expect((await docs.keyAccounts(boss)).sort()).toEqual([ids.bankCo, ids.bankStore].sort());
    expect(await docs.setKeyAccount(boss, ids.bankCo, false)).toEqual([ids.bankStore]);
    await expect(docs.setKeyAccount(other, ids.bankCo, true)).rejects.toThrow(/不存在/); // 别的公司的账户
    await expect(docs.setKeyAccount(boss, ids.store, true)).rejects.toThrow(/不存在/); // 不是银行账户
    await expect(docs.keyAccounts({ ...boss, permissions: { isCompanyAdmin: false, allow: [], deny: [] } })).rejects.toThrow(/权限/);
    await expect(docs.setKeyAccount({ ...boss, permissions: { isCompanyAdmin: false, allow: [], deny: [] } }, ids.bankCo, true)).rejects.toThrow(/权限/);
  });

  it('银行流水号：收付款类单据也能登记，同一个流水号不分单据类型全公司只能用一次', async () => {
    const pay = await docs.createDraft(boss, { type: 'payment', date: day, partyId: ids.supp, bankAccountId: ids.bankCo, amountCents: 100, refNo: 'BANK-0001' });
    expect(pay.refNo).toBe('BANK-0001');
    await expect(docs.createDraft(boss, { type: 'payment', date: day, partyId: ids.supp, bankAccountId: ids.bankCo, amountCents: 100, refNo: 'BANK-0001' })).rejects.toThrow(/银行流水号 BANK-0001 已经登记过/);
    await expect(docs.createDraft(boss, { type: 'receipt', date: day, partyId: ids.cust, bankAccountId: ids.bankCo, amountCents: 100, refNo: ' BANK-0001 ' })).rejects.toThrow(/已经登记过/);
    await expect(docs.createDraft(boss, { type: 'withdrawal', date: day, storeId: ids.store, bankAccountId: ids.bankCo, amountCents: 100, refNo: 'BANK-0001' })).rejects.toThrow(/已经登记过/);
    // 修改草稿自己保留原流水号不算重复；换成别人的才算
    await docs.updateDraft(boss, pay.id, { type: 'payment', date: day, partyId: ids.supp, bankAccountId: ids.bankCo, amountCents: 200, refNo: 'BANK-0001' });
    const other2 = await docs.createDraft(boss, { type: 'payment', date: day, partyId: ids.supp, bankAccountId: ids.bankCo, amountCents: 100, refNo: 'BANK-0002' });
    await expect(docs.updateDraft(boss, other2.id, { type: 'payment', date: day, partyId: ids.supp, bankAccountId: ids.bankCo, amountCents: 100, refNo: 'BANK-0001' })).rejects.toThrow(/已经登记过/);
    // 不填流水号的不受影响；别的公司可以用同一个流水号
    await docs.createDraft(boss, { type: 'payment', date: day, partyId: ids.supp, bankAccountId: ids.bankCo, amountCents: 100 });
    await docs.createDraft(boss, { type: 'payment', date: day, partyId: ids.supp, bankAccountId: ids.bankCo, amountCents: 100 });
    expect(pay.id).toBeGreaterThan(0);
  });
});
