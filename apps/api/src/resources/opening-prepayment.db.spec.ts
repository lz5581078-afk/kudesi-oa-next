import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { OPENING_PREPAYMENT_PERMISSION } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, FinanceDocument, FinanceEntry, ResourceFile, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { FinanceDocumentsService, OPENING_VOUCHER_TYPE } from './finance-documents.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('期初预付登记（真实数据库）', () => {
  let ds: DataSource, docs: FinanceDocumentsService, boss: AuthUser;
  let supplierId: number, bankId: number, warehouseId: number, productId: number;
  const day = '2026-10-26';
  const payload = (fileId: number) => ({ reason: '核对上线前银行回单及供应商余额', fileIds: [fileId], confirmed: true });
  const balance = async () => (await docs.bankBalances(boss)).find((b) => b.id === bankId)!.balanceCents;
  const prepay = async () => Number((await ds.query("SELECT COALESCE(SUM(amount_cents),0) s FROM finance_entries WHERE company_id=? AND kind='prepayment' AND account_id=?", [boss.companyId, supplierId]))[0].s);
  async function voucher(patch: Partial<ResourceFile> = {}) {
    return ds.manager.save(ResourceFile, ds.manager.create(ResourceFile, { companyId: boss.companyId, resourceType: OPENING_VOUCHER_TYPE, resourceId: null, fieldKey: 'voucher', storageKey: crypto.randomUUID(), name: '付款回单.pdf', mime: 'application/pdf', size: 100, uploadedBy: boss.id, ...patch }));
  }
  async function issued(sourceKey?: string) {
    const doc = await docs.createDraft(boss, { type: 'prepayment', date: day, partyId: supplierId, bankAccountId: bankId, amountCents: 10000 }, { sourceKey });
    return docs.issue(boss, doc.id);
  }
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    docs = new FinanceDocumentsService(ds);
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `op${crypto.randomBytes(5).toString('hex')}`, name: '期初测试', status: 'active' }));
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '测试员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: user.id, companyId: company.id, name: user.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const svc = buildServices(ds).resources;
    supplierId = (await svc.create(boss, 'finance-suppliers', { name: '期初供应商' })).id;
    bankId = (await svc.create(boss, 'bank-accounts', { kind: 'company_public', accountName: '期初银行', bank: '测试银行', accountNo: '6222000000000001', balance: 50000 })).id;
    warehouseId = (await svc.create(boss, 'finance-warehouses', { name: '期初仓库' })).id;
    const cat = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '期初商品类', code: 'QC' })).id;
    productId = (await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '期初原料', categoryId: cat, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('登记借贷平衡且银行余额不变，附件与审计落库；余额可供采购抵扣', async () => {
    const doc = await issued(), file = await voucher(), before = await balance(), prev = await prepay();
    const posted = await docs.registerOpeningPrepayment(boss, doc.id, payload(file.id));
    expect(posted.status).toBe('posted');
    expect(posted.paidCents).toBe(0);
    expect(posted.entries.map((e) => [e.kind, e.amountCents])).toEqual([['prepayment', 10000], ['opening', -10000]]);
    expect(posted.events.find((e) => e.action === 'opening-prepay')?.note).toBe(payload(file.id).reason);
    expect(posted.openingVouchers.map((f) => f.id)).toEqual([file.id]);
    expect(await balance()).toBe(before);
    expect(await prepay()).toBe(prev + 10000);
    expect((await ds.manager.findOneByOrFail(AuditLog, { companyId: boss.companyId, action: 'finance.opening-prepayment', resourceId: String(doc.id) })).detail).toMatchObject({ amountCents: 10000, fileIds: [file.id], supplierId });
    const buy = await docs.createDraft(boss, { type: 'purchase-in', date: day, partyId: supplierId, warehouseId, offsetCents: 10000, lines: [{ productId, qty: 1, unitPriceCents: 10000 }] });
    await docs.post(boss, buy.id);
    expect(await prepay()).toBe(prev);
    expect(await balance()).toBe(before);
    await expect(docs.reverse(boss, doc.id, '已被抵扣')).rejects.toThrow(/余额不够/);
  });

  it('并发登记同一张单据只有一次成功，不能再走普通过账', async () => {
    const doc = await issued(), file = await voucher(), before = await balance();
    const results = await Promise.allSettled([docs.registerOpeningPrepayment(boss, doc.id, payload(file.id)), docs.registerOpeningPrepayment(boss, doc.id, payload(file.id))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await ds.manager.count(FinanceEntry, { where: { companyId: boss.companyId, documentId: doc.id } })).toBe(2);
    await expect(docs.post(boss, doc.id)).rejects.toThrow(/状态/);
    expect(await balance()).toBe(before);
    const reversed = await docs.reverse(boss, doc.id, '核对错误撤销');
    expect(reversed.entries.map((e) => [e.kind, e.amountCents])).toEqual([['prepayment', -10000], ['opening', 10000]]);
    expect(await balance()).toBe(before);
  });

  it('普通过账权限不能代替登记权限；登记还要求单据查看权限', async () => {
    const doc = await issued(), file = await voucher();
    const user = (allow: string[]): AuthUser => ({ ...boss, permissions: { isCompanyAdmin: false, allow, deny: [] } });
    await expect(docs.registerOpeningPrepayment(user(['finance.docs.post', 'finance.history.view']), doc.id, payload(file.id))).rejects.toThrow(/权限/);
    await expect(docs.checkOpeningPrepayment(user(['finance.docs.post']), doc.id)).rejects.toThrow(/权限/);
    await expect(docs.registerOpeningPrepayment(user([OPENING_PREPAYMENT_PERMISSION]), doc.id, payload(file.id))).rejects.toThrow(/查看/);
    const result = await docs.registerOpeningPrepayment(user([OPENING_PREPAYMENT_PERMISSION, 'finance.history.view']), doc.id, payload(file.id));
    expect(result.status).toBe('posted');
  });

  it.each([
    ['空说明', { reason: '  ' }], ['超长说明', { reason: '字'.repeat(501) }], ['未确认', { confirmed: false }],
    ['无凭证', { fileIds: [] }], ['重复凭证', { fileIds: [1, 1] }], ['超额凭证', { fileIds: Array.from({ length: 11 }, (_, i) => i + 1) }],
  ])('拒绝%s', async (_name, patch) => {
    const doc = await issued(), file = await voucher();
    await expect(docs.registerOpeningPrepayment(boss, doc.id, { ...payload(file.id), ...patch })).rejects.toThrow();
    expect((await docs.get(boss, doc.id)).status).toBe('issued');
  });

  it.each(['flow:opening', 'import:opening'])('拒绝非手工来源 %s', async (key) => {
    const doc = await issued(key), file = await voucher();
    await expect(docs.registerOpeningPrepayment(boss, doc.id, payload(file.id))).rejects.toThrow(/手工/);
  });

  it.each(['draft', 'posted', 'reversed'] as const)('拒绝 %s 状态', async (status) => {
    const doc = await issued(), file = await voucher();
    await ds.manager.update(FinanceDocument, doc.id, { status });
    await expect(docs.registerOpeningPrepayment(boss, doc.id, payload(file.id))).rejects.toThrow(/已开立/);
  });

  it.each([0, -1])('拒绝金额 %d', async (amountCents) => {
    const doc = await issued(), file = await voucher();
    await ds.manager.update(FinanceDocument, doc.id, { amountCents });
    await expect(docs.registerOpeningPrepayment(boss, doc.id, payload(file.id))).rejects.toThrow(/金额/);
  });

  it('拒绝其他单据类型和跨公司单据', async () => {
    const doc = await issued(), file = await voucher();
    await ds.manager.update(FinanceDocument, doc.id, { docType: 'payment' });
    await expect(docs.registerOpeningPrepayment(boss, doc.id, payload(file.id))).rejects.toThrow(/供应商预付款/);
    await expect(docs.registerOpeningPrepayment({ ...boss, companyId: boss.companyId + 100000 }, doc.id, payload(file.id))).rejects.toThrow(/不存在/);
  });

  it.each([
    { resourceType: 'withdrawal-voucher' }, { fieldKey: 'other' }, { resourceId: 999999 }, { uploadedBy: null }, { mime: 'text/html' },
  ])('拒绝非法附件 %j，并回滚所有入账状态', async (patch) => {
    const doc = await issued(), file = await voucher(patch), before = await balance();
    await expect(docs.registerOpeningPrepayment(boss, doc.id, payload(file.id))).rejects.toThrow(/凭证/);
    expect((await docs.get(boss, doc.id)).status).toBe('issued');
    expect(await ds.manager.count(FinanceEntry, { where: { documentId: doc.id, companyId: boss.companyId } })).toBe(0);
    expect(await balance()).toBe(before);
  });

  it('拒绝其他公司的凭证', async () => {
    const other = await ds.manager.save(Company, ds.manager.create(Company, { code: `of${crypto.randomBytes(5).toString('hex')}`, name: '其他公司', status: 'active' }));
    const doc = await issued(), file = await voucher({ companyId: other.id });
    await expect(docs.registerOpeningPrepayment(boss, doc.id, payload(file.id))).rejects.toThrow(/凭证/);
    expect((await docs.get(boss, doc.id)).status).toBe('issued');
  });

  it('同一附件不能绑定两张单；凭证读取必须有查看权限且匹配公司和单据', async () => {
    const a = await issued(), b = await issued(), f = await voucher();
    await docs.registerOpeningPrepayment(boss, a.id, payload(f.id));
    await expect(docs.registerOpeningPrepayment(boss, b.id, payload(f.id))).rejects.toThrow(/凭证/);
    expect((await docs.openingVoucher(boss, a.id, f.id)).id).toBe(f.id);
    await expect(docs.openingVoucher(boss, b.id, f.id)).rejects.toThrow(/不存在/);
    await expect(docs.openingVoucher({ ...boss, companyId: boss.companyId + 100000 }, a.id, f.id)).rejects.toThrow(/不存在/);
    await expect(docs.openingVoucher({ ...boss, permissions: { isCompanyAdmin: false, allow: [], deny: [] } }, a.id, f.id)).rejects.toThrow(/查看/);
  });

  it('普通预付款过账仍然扣减银行余额', async () => {
    const doc = await issued(), before = await balance();
    await docs.post(boss, doc.id);
    expect(await balance()).toBe(before - 10000);
  });
});
