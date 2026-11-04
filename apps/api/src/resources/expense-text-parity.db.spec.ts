/** 自由相关单位是单据文字，不得自动变成应付账户；仅隔离合成资料。 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { DocInput } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FinanceEntry, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { FinanceDocumentsService } from './finance-documents.service';
const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('24号费用单自由单位与独立摘要', () => {
  let ds: DataSource, docs: FinanceDocumentsService, actor: AuthUser, bank: number, fee: number, supplier: number;
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true }).initialize();
    docs = new FinanceDocumentsService(ds);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `et${randomBytes(5).toString('hex')}`, name: '费用文字隔离公司', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '合成管理员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    actor = { id: u.id, companyId: c.id, name: u.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const svc = buildServices(ds).resources;
    bank = (await svc.create(actor, 'bank-accounts', { kind: 'cashier_account', accountName: '合成出纳', bank: '测试银行', accountNo: '6222000011112222', balance: 100000 })).id;
    fee = (await svc.create(actor, 'finance-fee-items', { name: '合成运输费', direction: 'expense' })).id;
    supplier = (await svc.create(actor, 'finance-suppliers', { name: '合成结算供应商' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });
  const input = (extra: Partial<DocInput> = {}): DocInput => ({ type: 'expense', date: '2026-10-24', counterpartyName: '合成临时司机', settlementMode: 'full', paidCents: 1800, bankAccountId: bank, lines: [{ feeItemId: fee, qty: 1, unitPriceCents: 1800 }], ...extra });
  const balance = async () => (await docs.bankBalances(actor)).find(row => row.id === bank)!.balanceCents;
  it('手填3元预付冲抵只消耗3元预付，费用10元剩余7元挂真实供应商，不重复支出银行',async()=>{
    const before=await balance();
    const advance=await docs.post(actor,(await docs.createDraft(actor,{type:'prepayment',date:'2026-10-24',partyId:supplier,bankAccountId:bank,settlementMode:'full',paidCents:1000,lines:[{itemName:'合成预付',qty:1,unitPriceCents:1000}]})).id);
    expect(await balance()).toBe(before-1000);
    const draft=await docs.createDraft(actor,input({partyId:supplier,partyKind:'supplier',settlementMode:'offset',paidCents:0,offsetCents:300,bankAccountId:null,lines:[{feeItemId:fee,qty:1,unitPriceCents:1000}]}));
    const posted=await docs.post(actor,draft.id);expect(posted).toMatchObject({paidCents:0,offsetCents:300,settlementMode:'offset'});expect(posted.entries.some(row=>row.kind==='bank')).toBe(false);expect(posted.entries.find(row=>row.kind==='prepayment')).toMatchObject({accountId:supplier,amountCents:-300});expect(posted.entries.find(row=>row.kind==='payable')).toMatchObject({accountId:supplier,amountCents:-700});expect(await balance()).toBe(before-1000);
    const copy=await docs.copyAsDraft(actor,draft.id);expect(copy).toMatchObject({paidCents:0,offsetCents:300,settlementMode:'offset'});await docs.deleteDraft(actor,copy.id);await docs.reverse(actor,draft.id,'合成部分预付冲回');await docs.reverse(actor,advance.id,'合成预付来源冲回');expect(await balance()).toBe(before);
  });

  it('自由单位、独立摘要和备注经过保存、过账、复制、修改说明、红冲仍分别保留', async () => {
    const before = await balance();
    const draft = await docs.createDraft(actor, input({ summary: '合成独立摘要' }), { memo: '合成单据备注' });
    expect(draft).toMatchObject({ partyId: null, counterpartyName: '合成临时司机', partyName: '合成临时司机', summary: '合成独立摘要', memo: '合成单据备注' });
    const posted = await docs.post(actor, draft.id);
    expect(posted.entries.find(row => row.kind === 'bank')).toMatchObject({ accountId: bank, amountCents: -1800 });
    expect(posted.entries.some(row => row.kind === 'payable')).toBe(false);
    const copy = await docs.copyAsDraft(actor, draft.id);
    expect(copy).toMatchObject({ partyId: null, counterpartyName: '合成临时司机', summary: '合成独立摘要', memo: '合成单据备注' });
    const edited = await docs.editHeader(actor, draft.id, { summary: '合成更新摘要', memo: '合成更新备注' });
    expect(edited).toMatchObject({ summary: '合成更新摘要', memo: '合成更新备注' });
    expect((await docs.bankLedger(actor, bank)).rows).toEqual(expect.arrayContaining([expect.objectContaining({ documentId: draft.id, partyName: '合成临时司机', summary: '合成更新摘要', memo: '合成更新备注' })]));
    const list = await docs.list(actor, { scope: 'expense', keyword: '合成更新摘要', page: 1, pageSize: 20 });
    expect(list.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: draft.id, partyName: '合成临时司机', summary: '合成更新摘要', memo: '合成更新备注' })]));
    const reversed = await docs.reverse(actor, draft.id, '合成冲回');
    expect(reversed).toMatchObject({ counterpartyName: '合成临时司机', summary: '合成更新摘要' });
    expect(await balance()).toBe(before);
    expect(await ds.manager.countBy(ResourceRecord, { companyId: actor.companyId, type: 'finance-suppliers' })).toBe(1);
  });

  it.each(['part', 'credit', 'offset'] as const)('%s 允许自由单位开立，未绑定真实账户不能挂账过账，失败不写分录', async mode => {
    const before = await balance();
    const draft = await docs.createDraft(actor, input({ settlementMode: mode, paidCents: mode === 'part' ? 300 : 0, offsetCents: mode === 'offset' ? 1800 : 0 }));
    const issued = await docs.issue(actor, draft.id);
    expect(issued).toMatchObject({ status: 'issued', summary: '合成运输费等1项费用', counterpartyName: '合成临时司机' });
    await expect(docs.post(actor, draft.id)).rejects.toThrow(/选择/);
    expect((await docs.get(actor, draft.id)).status).toBe('issued');
    expect(await ds.manager.countBy(FinanceEntry, { companyId: actor.companyId, documentId: draft.id })).toBe(0);
    expect(await balance()).toBe(before);
  });

  it('自由单位文字和真实挂账对象各自保留；应付只记真实ID', async () => {
    const draft = await docs.createDraft(actor, input({ partyId: supplier, partyKind: 'supplier', settlementMode: 'part', paidCents: 300 }));
    const posted = await docs.post(actor, draft.id);
    expect(posted).toMatchObject({ counterpartyName: '合成临时司机', partyName: '合成临时司机', linkedPartyName: '合成结算供应商' });
    expect(posted.entries.find(row => row.kind === 'payable')).toMatchObject({ accountId: supplier, amountCents: -1500 });
    expect(posted.entries.some(row => row.kind === 'payable' && row.accountId === 0)).toBe(false);
    await docs.reverse(actor, draft.id, '合成冲回挂账');
  });

  it('明确选择欠款而实付留空时按0保存，不能回退成全款', async () => {
    const draft = await docs.createDraft(actor, input({ settlementMode: 'credit', paidCents: null }));
    expect(draft.paidCents).toBe(0);
    const issued = await docs.issue(actor, draft.id);
    expect(issued.paidCents).toBe(0);
    await expect(docs.post(actor, draft.id)).rejects.toThrow(/挂账往来档案/);
  });

  it('内部调用同样检查文字长度；省略保留、空串明确清空，跨公司读取被拒绝', async () => {
    await expect(docs.createDraft(actor, input({ counterpartyName: '字'.repeat(161) }))).rejects.toThrow(/160/);
    await expect(docs.createDraft(actor, input({ summary: '字'.repeat(256) }))).rejects.toThrow(/255/);
    const draft = await docs.createDraft(actor, input({ summary: '合成草稿摘要' }), { memo: '保留备注' });
    const next = input(); delete next.summary; delete next.counterpartyName;
    expect(await docs.updateDraft(actor, draft.id, next)).toMatchObject({ counterpartyName: '合成临时司机', summary: '合成草稿摘要', memo: '保留备注' });
    expect(await docs.updateDraft(actor, draft.id, { ...next, summary: '', counterpartyName: '' })).toMatchObject({ counterpartyName: null, summary: null, memo: '保留备注' });
    await expect(docs.get({ ...actor, companyId: actor.companyId + 999999 }, draft.id)).rejects.toThrow(/不存在/);
  });
});
