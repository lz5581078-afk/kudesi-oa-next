/** 金额用途与实际收付款分开；只运行于隔离测试库。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { FinanceDocumentsService } from './finance-documents.service';

const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('财务24号金额单实际收付', () => {
  let ds: DataSource, docs: FinanceDocumentsService, actor: AuthUser;
  let bank: number, customer: number, supplier: number;
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `settle${crypto.randomBytes(5).toString('hex')}`, name: '收付对照隔离公司', status: 'active' }));
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '管理员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    actor = { id: user.id, companyId: company.id, name: user.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const svc = buildServices(ds).resources;
    docs = new FinanceDocumentsService(ds);
    bank = (await svc.create(actor, 'bank-accounts', { kind: 'cashier_account', accountName: '合成测试出纳', bank: '测试银行', accountNo: '6222000077778888', balance: 100000 })).id;
    customer = (await svc.create(actor, 'finance-customers', { name: '合成测试客户' })).id;
    supplier = (await svc.create(actor, 'finance-suppliers', { name: '合成测试供应商' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });
  const balance = async () => (await docs.bankBalances(actor)).find(row => row.id === bank)!.balanceCents;
  it('暂未付款按钮后明确手填3元，保留方式并按看得见的3元记账，不静默改成0',async()=>{
    const before=await balance(),draft=await docs.createDraft(actor,{type:'payment',date:'2026-10-24',partyId:supplier,bankAccountId:bank,settlementMode:'credit',paidCents:300,lines:[{itemName:'合成手填付款',qty:1,unitPriceCents:1000}]});
    expect(draft).toMatchObject({paidCents:300,settlementMode:'credit'});const posted=await docs.post(actor,draft.id);expect(posted.entries.find(entry=>entry.kind==='bank')?.amountCents).toBe(-300);expect(await balance()).toBe(before-300);await docs.reverse(actor,draft.id,'合成手填付款冲回');expect(await balance()).toBe(before);
  });
  it.each(['advance-receipt','receipt','payment','prepayment'] as const)('%s 保留全款选中但实填3元，保存/更新/过账/复制/红冲均按3元，显式0不默认为10',async type=>{
    const before=await balance(),incoming=type==='receipt'||type==='advance-receipt';
    const input={type,date:'2026-10-24',partyId:incoming?customer:supplier,bankAccountId:bank,settlementMode:'full' as const,paidCents:300,lines:[{itemName:'合成手填用途',qty:1,unitPriceCents:1000}]};
    const created=await docs.createDraft(actor,input);expect(created).toMatchObject({amountCents:1000,paidCents:300,settlementMode:'full'});
    expect(await docs.updateDraft(actor,created.id,input)).toMatchObject({paidCents:300,settlementMode:'full'});const posted=await docs.post(actor,created.id);expect(posted.entries.find(entry=>entry.kind==='bank')?.amountCents).toBe(incoming?300:-300);expect(await balance()).toBe(before+(incoming?300:-300));
    const copy=await docs.copyAsDraft(actor,created.id);expect(copy).toMatchObject({amountCents:1000,paidCents:300,settlementMode:'full'});await docs.deleteDraft(actor,copy.id);await docs.reverse(actor,created.id,'合成手填实际金额冲回');expect(await balance()).toBe(before);
    const zero=await docs.createDraft(actor,{...input,paidCents:0,bankAccountId:null});expect(zero.paidCents).toBe(0);expect((await docs.post(actor,zero.id)).entries.some(entry=>entry.kind==='bank')).toBe(false);expect(await balance()).toBe(before);
  });
  it.each(['advance-receipt', 'receipt', 'payment', 'prepayment'] as const)('%s 合计10元实际3元，保存/过账/复制/红冲均保留金额及方式', async type => {
    const before = await balance();
    const incoming = type === 'receipt' || type === 'advance-receipt';
    const draft = await docs.createDraft(actor, { type, date: '2026-10-24', partyId: incoming ? customer : supplier, bankAccountId: bank, settlementMode: 'part', paidCents: 300, lines: [{ itemName: '合成用途', qty: 1, unitPriceCents: 1000 }] });
    expect(draft).toMatchObject({ amountCents: 1000, paidCents: 300, settlementMode: 'part' });
    const posted = await docs.post(actor, draft.id);
    expect(posted.entries.find(entry => entry.kind === 'bank')!.amountCents).toBe(incoming ? 300 : -300);
    expect(posted.entries.reduce((sum, entry) => sum + Number(entry.amountCents), 0)).toBe(0);
    expect(await balance()).toBe(before + (incoming ? 300 : -300));
    const copy = await docs.copyAsDraft(actor, draft.id);
    expect(copy).toMatchObject({ amountCents: 1000, paidCents: 300, settlementMode: 'part' });
    await docs.deleteDraft(actor, copy.id);
    await docs.reverse(actor, draft.id, '合成数据回归冲回');
    expect(await balance()).toBe(before);
    await expect(docs.get({ ...actor, companyId: actor.companyId + 10000000 }, draft.id)).rejects.toThrow(/不存在/);
  });
  it('旧模式为空、paid为0的金额单，仍按合计全额记账', async () => {
    const before = await balance();
    const draft = await docs.createDraft(actor, { type: 'receipt', date: '2026-10-24', partyId: customer, bankAccountId: bank, amountCents: 1000 });
    await ds.manager.query('UPDATE finance_documents SET paid_cents = 0, settlement_mode = NULL WHERE id = ? AND company_id = ?', [draft.id, actor.companyId]);
    const posted = await docs.post(actor, draft.id);
    expect(posted.entries.find(entry => entry.kind === 'bank')!.amountCents).toBe(1000);
    expect(await balance()).toBe(before + 1000);
    await docs.reverse(actor, draft.id, '旧数据兼容回归冲回');
    expect(await balance()).toBe(before);
  });
  it('暂未付款不需要账户也不动银行；结算分配不能用尚未实际支付的总额', async () => {
    const before = await balance();
    const input = { type: 'payment' as const, date: '2026-10-24', partyId: supplier, settlementMode: 'credit' as const, paidCents: 0, amountCents: 1000 };
    const unpaid = await docs.createDraft(actor, input);
    await docs.issue(actor, unpaid.id);
    expect(await balance()).toBe(before);
    const bad = await docs.createDraft(actor, { ...input, settlementMode: 'part', bankAccountId: bank, paidCents: 300, settleBy: 'doc', settlements: [{ sourceDocId: unpaid.id, amountCents: 1000 }] });
    await expect(docs.issue(actor, bad.id)).rejects.toThrow(/结算单据合计/);
  });
});
