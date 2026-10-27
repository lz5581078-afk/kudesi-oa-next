/**
 * 证照与主体类资料的专属规则（真实数据库）。
 *   RESOURCE_DB_TEST=1 TEST_DB_NAME=<库> npx jest --runInBand entities-a
 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('证照与主体（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let staffId: number;
  let n = 0;
  const lic = (extra: Record<string, unknown> = {}) => {
    n += 1;
    return { category: 'operation', companyName: `甲主体${n}`, creditCode: `91A${n}${Date.now()}`, legalPerson: `法人${n}`, ...extra };
  };

  beforeAll(async () => {
    const options = buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' });
    ds = new DataSource({ ...options, migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `ea${crypto.randomBytes(4).toString('hex')}`, name: '证照测试公司', status: 'active' }));
    const admin = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    const staff = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'op', passwordHash: 'x', name: '小借', status: 'active', mustChangePassword: false, isCompanyAdmin: false }));
    staffId = staff.id;
    boss = { id: admin.id, companyId: company.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('执照：对账日季度写成 Q-END-N、派生标记、印章联动与实物联动', async () => {
    const a = await svc.create(boss, 'licenses', lic({ reconcileCycle: 'quarterly', reconcileDay: '15', annualAuditDay: '03-20', officialState: 'missing', officialKind: 'anti_fake', copyState: 'missing', copyLocationId: undefined }));
    expect(a.data.reconcileDay).toBe('Q-END-15');
    expect(a.data.annualAuditMonth).toBe('03');
    expect(a.data.sealFlag).toBe('lost');
    expect(a.data.photoFlag).toBe('gap');
    expect(a.data.locationFlag).toBe('none');
    expect(a.data.officialKind).toBeUndefined();
    await expect(svc.create(boss, 'licenses', lic({ reconcileCycle: 'monthly', reconcileDay: '40' }))).rejects.toThrow(/1 到 31/);
    // 只把种类改回防伪章 = 取消普通章
    const b = await svc.create(boss, 'licenses', lic({ financeState: 'ordinary_kept' }));
    expect(b.data.financeKind).toBe('self_carved');
    const b2 = await svc.update(boss, 'licenses', b.id, { financeKind: 'anti_fake' });
    expect(b2.data.financeState).toBe('kept');
    const filtered = await svc.list(boss, 'licenses', { filters: JSON.stringify({ annualAuditMonth: '03', sealFlag: 'lost' }) });
    expect(filtered.items.some((x) => x.id === a.id)).toBe(true);
  });

  it('借用记录：员工或外部人员、借出情况显示在执照上、登记归还', async () => {
    const l = await svc.create(boss, 'licenses', lic());
    await expect(svc.create(boss, 'license-borrows', { licenseId: l.id, item: 'original', purpose: '办卡', borrowedAt: '2026-10-01' })).rejects.toThrow(/借用人/);
    const b1 = await svc.create(boss, 'license-borrows', { licenseId: l.id, item: 'original', borrowerUserId: staffId, purpose: '办卡', borrowedAt: '2026-10-01', expectedReturnAt: '2026-10-09' });
    const b2 = await svc.create(boss, 'license-borrows', { licenseId: l.id, item: 'official', borrowerName: '外部会计', purpose: '报税', borrowedAt: '2026-10-02' });
    expect(b1.data.borrower).toBe('小借');
    expect(b2.data.borrower).toBe('外部会计');
    let cur = await svc.get(boss, 'licenses', l.id);
    expect(cur.data.borrowedSummary).toBe('正本：小借借走，预计 2026-10-09 归还；公章：外部会计借走');
    const back = await svc.changeStatus(boss, 'license-borrows', b1.id, 'returned');
    expect(back.data.returnedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    cur = await svc.get(boss, 'licenses', l.id);
    expect(cur.data.borrowedSummary).toBe('公章：外部会计借走');
    const viaDate = await svc.update(boss, 'license-borrows', b2.id, { returnedAt: '2026-10-05' });
    expect(viaDate.status).toBe('returned');
    expect((await svc.get(boss, 'licenses', l.id)).data.borrowedSummary).toBeUndefined();
    const u = await svc.create(boss, 'license-usages', { licenseId: l.id, item: 'original', purpose: '入驻', usedAt: '2026-10-01', relatedObject: '某店铺' });
    expect(u.data.usageType).toBe('业务办理');
    expect(u.data.relatedObject).toBe('某店铺');
  });

  it('银行账户为准回写执照；账号格式校验；U 盾个数、编号、借出遗失、默认保管人', async () => {
    const l = await svc.create(boss, 'licenses', lic({ legalPerson: '王法人' }));
    await expect(svc.create(boss, 'bank-accounts', { kind: 'company_public', accountName: 'x', bank: '工行', accountNo: 'abc' })).rejects.toThrow(/6 到 40 位/);
    const ba = await svc.create(boss, 'bank-accounts', { kind: 'company_public', accountName: '甲公司', bank: '工商银行', accountNo: '6222 0202 0001', licenseId: l.id, keeperUserId: staffId });
    const card = await svc.create(boss, 'bank-accounts', { kind: 'company_card', accountName: '王法人', bank: '建设银行', accountNo: '6217000011112222', licenseId: l.id, reservedPhoneNumber: '13700000001' });
    let cur = await svc.get(boss, 'licenses', l.id);
    expect(cur.data.publicAccountName).toBe('甲公司');
    expect(cur.data.publicAccountNo).toBe('6222 0202 0001');
    expect(cur.data.legalCardNo).toBe('6217000011112222');
    expect(cur.data.legalCardPhone).toBe('13700000001');
    expect(cur.data.publicAccountFlag).toBe('yes');
    await svc.update(boss, 'bank-accounts', ba.id, { bank: '农业银行' });
    expect((await svc.get(boss, 'licenses', l.id)).data.publicAccountBank).toBe('农业银行');
    // U 盾
    const s1 = await svc.create(boss, 'u-shields', { bankAccountId: ba.id, name: '工行盾', shieldNo: 'U-001' });
    expect(s1.data.keeperUserId).toBe(staffId);
    expect((await svc.get(boss, 'bank-accounts', ba.id)).data.shieldCount).toBe(1);
    await svc.changeStatus(boss, 'u-shields', s1.id, 'borrowed');
    await svc.changeStatus(boss, 'u-shields', s1.id, 'lost');
    expect((await svc.get(boss, 'bank-accounts', ba.id)).data.shieldCount).toBe(1);
    await svc.changeStatus(boss, 'u-shields', s1.id, 'inactive', '作废');
    const bank = await svc.get(boss, 'bank-accounts', ba.id);
    expect(bank.data.shieldCount).toBe(0);
    expect(bank.data.shieldFlag).toBe('none');
    // 多店铺 + 用途
    const st1 = await svc.create(boss, 'stores', { platform: 'pdd', name: '多店一' });
    const st2 = await svc.create(boss, 'stores', { platform: 'pdd', name: '多店二' });
    await svc.create(boss, 'bank-store-links', { bankAccountId: card.id, storeId: st1.id, purpose: '店铺收款' });
    await svc.create(boss, 'bank-store-links', { bankAccountId: card.id, storeId: st2.id, purpose: '提现' });
    await expect(svc.create(boss, 'bank-store-links', { bankAccountId: card.id, storeId: st2.id, purpose: '提现' })).rejects.toThrow(/同一用途/);
    expect((await svc.get(boss, 'bank-accounts', card.id)).data.storeFlag).toBe('yes');
    cur = await svc.get(boss, 'licenses', l.id);
    expect(cur.data.legalCardName).toBe('王法人');
  });

  it('商标：按日期推断状态；店铺授权带授权期并回写店铺；改名同步；店铺手写名称自动建授权', async () => {
    const tm = await svc.create(boss, 'trademarks', { source: 'owned', name: '好运牌', registeredAt: '2026-01-01', validUntil: '2036-01-01' });
    expect(tm.status).toBe('registered');
    const t2 = await svc.create(boss, 'trademarks', { source: 'owned', name: '二号牌', acceptedAt: '2026-02-01' });
    expect(t2.status).toBe('accepted');
    const store = await svc.create(boss, 'stores', { platform: 'pdd', name: '授权店' });
    const a1 = await svc.create(boss, 'trademark-authorizations', { trademarkId: tm.id, storeId: store.id, validFrom: '2026-01-01', validTo: '2027-01-01' });
    expect(a1.title).toBe('好运牌 → 授权店');
    let s = await svc.get(boss, 'stores', store.id);
    expect(s.data.trademark).toBe('好运牌');
    expect(s.data.trademarkExpireAt).toBe('2027-01-01');
    await svc.create(boss, 'trademark-authorizations', { trademarkId: t2.id, storeId: store.id, validTo: '2028-05-05' });
    s = await svc.get(boss, 'stores', store.id);
    expect(s.data.trademark).toBe('二号牌');
    await svc.update(boss, 'trademarks', t2.id, { name: '二号牌改' });
    s = await svc.get(boss, 'stores', store.id);
    expect(s.data.trademark).toBe('二号牌改');
    await svc.remove(boss, 'trademark-authorizations', (await svc.list(boss, 'trademark-authorizations', { fieldKey: 'trademarkId', fieldValue: String(t2.id) })).items[0].id, '取消授权');
    s = await svc.get(boss, 'stores', store.id);
    expect(s.data.trademark).toBe('好运牌');
    const due = await svc.expiring(boss, 366, true, '2026-12-20');
    expect(due.rows.some((r) => r.type === 'trademark-authorizations' && r.dueDate === '2027-01-01')).toBe(true);
    // 店铺上手写档案里的商标名 -> 自动建授权
    const s2 = await svc.create(boss, 'stores', { platform: 'pdd', name: '手写店', trademark: '好运牌', trademarkExpireAt: '2026-12-31' });
    const auths = await svc.list(boss, 'trademark-authorizations', { fieldKey: 'storeId', fieldValue: String(s2.id) });
    expect(auths.total).toBe(1);
    expect(auths.items[0].data.validTo).toBe('2026-12-31');
  });

  it('税务资料：一张执照经营+电商两份，同类别不能重复；类别、名称默认取执照；合作人新字段', async () => {
    const l = await svc.create(boss, 'licenses', lic({ category: 'ecommerce' }));
    // 创建执照已自动生成一份电商税务
    const extra = await svc.create(boss, 'tax-profiles', { licenseId: l.id, taxCategory: 'operation', taxType: 'ordinary' });
    expect(extra.title).toBe(l.data.companyName);
    expect(extra.data.taxpayerNo).toBe(l.data.creditCode);
    await expect(svc.create(boss, 'tax-profiles', { licenseId: l.id, taxCategory: 'operation' })).rejects.toThrow(/同类别/);
    const dflt = await svc.create(boss, 'licenses', lic());
    expect((await svc.list(boss, 'tax-profiles', { fieldKey: 'licenseId', fieldValue: String(dflt.id) })).items[0].data.taxCategory).toBe('operation');

    await svc.create(boss, 'phones', { number: '13600000009', usageType: 'company_kept' });
    const p = await svc.create(boss, 'partners', { name: '合作商甲', partnerType: 'business', cooperationScope: '代运营', startedAt: '2026-01-01', cardHolder: '甲', cardPhone: '136-0000-0009', cardNo: '6222000000000001' });
    expect(p.data.cardPhoneId).toBeDefined();
    expect(p.data.cardFlag).toBe('yes');
    await expect(svc.create(boss, 'partners', { name: '倒置', startedAt: '2026-05-01', endedAt: '2026-01-01' })).rejects.toThrow(/结束时间/);
    const ab = await svc.changeStatus(boss, 'partners', p.id, 'abnormal');
    expect(ab.status).toBe('abnormal');
  });

  it('执照新增联动：法人手机号、同名法人档案复用并多关联、税务按识别号复用、无归属账户挂到本执照', async () => {
    const a = await svc.create(boss, 'licenses', lic({ legalPerson: '联动法人', legalCardNo: '6217009900001111', legalCardName: '联动法人', legalCardPhone: '13500000011' }));
    expect((await svc.list(boss, 'phones', { keyword: '13500000011' })).total).toBe(1);
    const partner = (await svc.list(boss, 'partners', { keyword: '联动法人' })).items[0];
    expect(partner.data.cooperationScope).toBe('营业执照法人');
    expect(partner.data.cardNo).toBe('6217009900001111');
    expect(partner.data.cardPhoneId).toBeDefined();
    const b = await svc.create(boss, 'licenses', lic({ legalPerson: '联动法人' }));
    expect((await svc.list(boss, 'partners', { keyword: '联动法人' })).total).toBe(1);
    const rels = await svc.relations(boss, 'partners', partner.id, () => true);
    expect(rels.some((r) => r.relation === 'manual' && r.id === b.id)).toBe(true);
    expect(a.id).not.toBe(b.id);
  });
});
