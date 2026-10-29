/**
 * 资料引擎的真实数据库测试（MySQL 8）。默认跳过，需要时：
 *   RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test npm test -w @kudesi/api -- resources.db
 * 每次运行用一个全新的公司，互不影响，也不需要清库。
 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const enabled = process.env.RESOURCE_DB_TEST === '1';
const d = enabled ? describe : describe.skip;

d('资料引擎（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let other: AuthUser;
  let activeUserId: number;
  let disabledUserId: number;

  const mkUser = (id: number, companyId: number): AuthUser => ({
    id,
    companyId,
    name: `u${id}`,
    permissions: { isCompanyAdmin: true, allow: [], deny: [] },
  });

  beforeAll(async () => {
    const options = buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' });
    ds = new DataSource({ ...options, migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;

    const mkCompany = async (tag: string) => {
      const code = `t${tag}${crypto.randomBytes(4).toString('hex')}`;
      const company = await ds.manager.save(Company, ds.manager.create(Company, { code, name: `测试公司${tag}`, status: 'active' }));
      const admin = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
      return { company, admin };
    };
    const a = await mkCompany('a');
    const b = await mkCompany('b');
    boss = mkUser(a.admin.id, a.company.id);
    other = mkUser(b.admin.id, b.company.id);
    const staff = await ds.manager.save(User, ds.manager.create(User, { companyId: a.company.id, account: 'op', passwordHash: 'x', name: '小运营', status: 'active', mustChangePassword: false, isCompanyAdmin: false }));
    const gone = await ds.manager.save(User, ds.manager.create(User, { companyId: a.company.id, account: 'old', passwordHash: 'x', name: '已离职', status: 'disabled', mustChangePassword: false, isCompanyAdmin: false }));
    activeUserId = staff.id;
    disabledUserId = gone.id;
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  const licenseInput = (n: string) => ({
    category: 'ecommerce',
    companyName: `某某农业有限公司${n}`,
    creditCode: `91310000MA1${n}`,
    legalPerson: '张三',
    legalPhone: '+86 138-0000-1111',
    publicAccountName: '某某农业有限公司',
    publicAccountBank: '工商银行',
    publicAccountNo: '6222020200012345678',
  });

  it('营业执照：缺必填项被拒绝，重复信用代码返回冲突', async () => {
    await expect(svc.create(boss, 'licenses', { category: 'operation' })).rejects.toThrow(/主体名称不能为空/);
    const first = { ...licenseInput('A001'), publicAccountNo: '6222020200000000001' };
    await svc.create(boss, 'licenses', first);
    await expect(svc.create(boss, 'licenses', first)).rejects.toThrow(/已存在/);
  });

  it('营业执照创建后自动生成手机号、合作人、税务资料、对公账户，账号明文显示、库里加密', async () => {
    const lic = await svc.create(boss, 'licenses', licenseInput('A002'));
    const phones = await svc.list(boss, 'phones', { keyword: '13800001111' });
    expect(phones.total).toBe(1);
    expect(phones.items[0].data.number).toBe('13800001111');
    const tax = await svc.list(boss, 'tax-profiles', { fieldKey: 'licenseId', fieldValue: String(lic.id) });
    expect(tax.total).toBe(1);
    const banks = await svc.list(boss, 'bank-accounts', { fieldKey: 'licenseId', fieldValue: String(lic.id) });
    expect(banks.total).toBe(1);
    // 账号对有权限的人明文显示，不做脱敏；数据库里仍是加密存放
    expect(banks.items[0].data.accountNo).toBe('6222020200012345678');
    const raw = await ds.query('SELECT data, secrets FROM resource_records WHERE id = ?', [banks.items[0].id]);
    expect(JSON.stringify(raw[0])).not.toContain('6222020200012345678');
    const revealed = await svc.reveal(boss, 'bank-accounts', banks.items[0].id, 'accountNo');
    expect(revealed.value).toBe('6222020200012345678');
    const logs = await svc.logs(boss, 'bank-accounts', banks.items[0].id);
    expect(logs.some((l) => l.action === 'reveal')).toBe(true);
  });

  it('店铺：绑定手机号必须已建档；同平台同手机号只能绑一个店铺', async () => {
    await svc.create(boss, 'phones', { number: '13900002222', usageType: 'company_kept' });
    await expect(svc.create(boss, 'stores', { platform: 'pdd', name: '甲店', phoneNumber: '13999999999' })).rejects.toThrow(/还没有建档/);
    const s1 = await svc.create(boss, 'stores', { platform: 'pdd', name: '甲店', phoneNumber: '139 0000 2222' });
    expect(s1.data.phoneId).toBeDefined();
    await expect(svc.create(boss, 'stores', { platform: 'pdd', name: '乙店', phoneNumber: '13900002222' })).rejects.toThrow(/已绑定了其他店铺/);
    const s3 = await svc.create(boss, 'stores', { platform: 'douyin', name: '丙店', phoneNumber: '13900002222' });
    expect(s3.id).toBeGreaterThan(0);
  });

  it('店铺：运营人必须在职；公共店铺会清空运营人；密码不出现在接口里且留空不覆盖', async () => {
    await expect(
      svc.create(boss, 'stores', { platform: 'jd', name: '丁店', claimStatus: 'claimed', operatorUserId: disabledUserId }),
    ).rejects.toThrow(/只能选在职员工/);
    const s = await svc.create(boss, 'stores', {
      platform: 'jd',
      name: '戊店',
      claimStatus: 'claimed',
      operatorUserId: activeUserId,
      storePassword: 'Secret-123',
    });
    expect(s.refLabels.operatorUserId).toBe('小运营');
    expect(s.secretConfigured.storePassword).toBe(true);
    expect(JSON.stringify(s)).not.toContain('Secret-123');
    const edited = await svc.update(boss, 'stores', s.id, { name: '戊店改名', storePassword: '' });
    expect(edited.secretConfigured.storePassword).toBe(true);
    expect((await svc.reveal(boss, 'stores', s.id, 'storePassword')).value).toBe('Secret-123');
    const pub = await svc.update(boss, 'stores', s.id, { claimStatus: 'public' });
    expect(pub.data.operatorUserId).toBeUndefined();
    const logs = await svc.logs(boss, 'stores', s.id);
    expect(JSON.stringify(logs)).not.toContain('Secret-123');
  });

  it('停用必须填原因；默认列表隐藏停用；删除=归档（旧系统同款）：必须填原因，被引用也能归档，关联不丢，可恢复', async () => {
    const lic = await svc.create(boss, 'licenses', { category: 'operation', companyName: '乙公司', creditCode: 'X-DEL-1', legalPerson: '李四' });
    await expect(svc.changeStatus(boss, 'licenses', lic.id, 'inactive', '')).rejects.toThrow(/必须填写原因/);
    const store = await svc.create(boss, 'stores', { platform: 'taobao', name: '引用执照的店', licenseId: lic.id });
    await svc.changeStatus(boss, 'licenses', lic.id, 'inactive', '公司已注销');
    expect((await svc.list(boss, 'licenses', { keyword: 'X-DEL-1' })).total).toBe(0);
    expect((await svc.list(boss, 'licenses', { keyword: 'X-DEL-1', showHidden: true })).total).toBe(1);
    expect((await svc.get(boss, 'licenses', lic.id)).statusReason).toBe('公司已注销');
    await expect(svc.remove(boss, 'stores', store.id, '')).rejects.toThrow(/必须填写归档原因/);
    await svc.remove(boss, 'stores', store.id, '录错了');
    // 归档后执照、合作人、税务资料仍互相关联；执照归档不受引用限制
    await svc.changeStatus(boss, 'licenses', lic.id, 'normal');
    const arch = (await svc.remove(boss, 'licenses', lic.id, '确认归档')) as { archived: { reason: string } | null };
    expect(arch.archived?.reason).toBe('确认归档');
    expect((await svc.get(boss, 'licenses', lic.id)).title).toBeTruthy();
    // 税务资料：对应执照已归档后才可归档
    const taxes = await svc.list(boss, 'tax-profiles', { fieldKey: 'licenseId', fieldValue: String(lic.id), showHidden: true });
    for (const t of taxes.items) await svc.remove(boss, 'tax-profiles', t.id, '随执照归档');
    const back = await svc.restore(boss, 'licenses', lic.id, '误归档');
    expect(back.status).toBe('normal');
  });

  it('公司之间互相隔离：读取、修改、引用别家记录都不行', async () => {
    const mine = await svc.create(boss, 'wechat', { name: '微信A', wechatNo: 'wx_iso_1' });
    await expect(svc.get(other, 'wechat', mine.id)).rejects.toThrow(/不存在/);
    await expect(svc.update(other, 'wechat', mine.id, { name: 'x' })).rejects.toThrow(/不存在/);
    expect((await svc.list(other, 'wechat', {})).total).toBe(0);
    await svc.create(other, 'wechat', { name: '微信B', wechatNo: 'wx_iso_1' }); // 不同公司可同号
    const theirPhone = await svc.create(other, 'phones', { number: '13600000077', usageType: 'company_kept' });
    await expect(svc.create(other, 'broadband', { account: 'bb1', phoneId: theirPhone.id, locationId: mine.id })).rejects.toThrow(/引用的记录不存在/);
  });

  it('手机号：规范化去重，计算下次充值日，子卡不能指向自己', async () => {
    const p = await svc.create(boss, 'phones', { number: '+86 137 0000 3333', usageType: 'personal_used', userId: activeUserId, lastRechargeAt: '2026-10-01' });
    expect(p.data.number).toBe('13700003333');
    expect(p.data.rechargeCycleDays).toBe(30);
    expect(p.data.nextRechargeAt).toBe('2026-10-31');
    await expect(svc.create(boss, 'phones', { number: '13700003333', usageType: 'company_kept' })).rejects.toThrow(/已存在/);
    await expect(svc.update(boss, 'phones', p.id, { parentPhoneId: p.id })).rejects.toThrow(/不能选自己/);
    const abnormal = await svc.update(boss, 'phones', p.id, { abnormalReason: '停机' });
    expect(abnormal.data.abnormalReason).toBeUndefined(); // 非异常状态不保存异常原因
  });

  it('位置树不能成环', async () => {
    const a = await svc.create(boss, 'locations', { name: '一楼', scope: 'area' });
    const b = await svc.create(boss, 'locations', { name: '仓库', scope: 'area', parentId: a.id });
    await expect(svc.update(boss, 'locations', a.id, { parentId: b.id })).rejects.toThrow(/循环/);
  });

  it('导入：预览不落库；有错整体回滚；正常导入按唯一字段更新', async () => {
    const rows = [
      { 平台: '拼多多', 店铺名: '导入店1' },
      { 平台: '淘宝', 店铺名: '导入店2' },
    ];
    const preview = await svc.importRows(boss, 'stores', rows, true);
    expect(preview.created).toBe(2);
    expect((await svc.list(boss, 'stores', { keyword: '导入店' })).total).toBe(0);

    const bad = await svc.importRows(boss, 'stores', [...rows, { 平台: '火星', 店铺名: '错店' }], false);
    expect(bad.committed).toBe(false);
    expect(bad.failed).toBe(1);
    expect((await svc.list(boss, 'stores', { keyword: '导入店' })).total).toBe(0);

    const ok = await svc.importRows(boss, 'wechat', [{ 名称: '导入微信', 微信号: 'wx_imp_1', 状态: '正常' }], false);
    expect(ok.committed).toBe(true);
    const again = await svc.importRows(boss, 'wechat', [{ 名称: '导入微信改名', 微信号: 'WX_IMP_1' }], false);
    expect(again.updated).toBe(1);
    expect((await svc.list(boss, 'wechat', { keyword: '改名' })).total).toBe(1);
  });

  it('导出不含密码、含证件号卡号，并防止公式注入', async () => {
    await svc.create(boss, 'software', { name: '=HYPERLINK("x")', account: 'acc', password: 'pw-export-1' });
    const out = await svc.exportCsv(boss, 'software', false);
    expect(out.csv).not.toContain('pw-export-1');
    expect(out.csv).toContain("'=HYPERLINK");
    // 证件号/卡号属于“应该显示的数据”，导出里有；密码不导出
    const banks = await svc.exportCsv(boss, 'bank-accounts', false);
    expect(banks.csv).toContain('6222020200012345678');
  });

  it('总览只统计有权限的类型，并给出到期预警', async () => {
    await svc.create(boss, 'qualifications', { type: 'general', name: '快到期资质', expiresAt: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
    await svc.overview(boss);
    const exp = await svc.expiring(boss, 30);
    expect(exp.rows.some((a) => a.name === '快到期资质' && a.status === 'due_soon')).toBe(true);
    const limited: AuthUser = { ...boss, permissions: { isCompanyAdmin: false, allow: ['resource.stores.view'], deny: [] } };
    const mine = await svc.overview(limited);
    expect(mine.items.map((i) => i.type)).toEqual(['stores']);
    expect((await svc.expiring(limited, 30)).rows.some((r) => r.type === 'qualifications')).toBe(false);
    expect(createChecker(limited.permissions)('resource.stores.secret')).toBe(false);
  });

  it('总览最近变更：按权限过滤，带资料名称和操作人，不含查看明文的记录', async () => {
    const q = await svc.create(boss, 'qualifications', { type: 'general', name: '最近变更用资质' });
    await svc.update(boss, 'qualifications', q.id, { note: '改备注' });
    const all = await svc.recentChanges(boss);
    const mine = all.filter((c) => c.resourceId === q.id && c.type === 'qualifications');
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine[0].name).toBe('最近变更用资质');
    expect(mine[0].typeLabel).toBe('资质证照');
    expect(all.every((c) => c.action !== 'reveal')).toBe(true);
    const limited: AuthUser = { ...boss, permissions: { isCompanyAdmin: false, allow: ['resource.stores.view'], deny: [] } };
    expect((await svc.recentChanges(limited)).some((c) => c.type === 'qualifications')).toBe(false);
    expect((await svc.recentChanges(other)).some((c) => c.resourceId === q.id && c.type === 'qualifications')).toBe(false);
  });

  it('未建档手机号：一键建档并绑定；同号码已有档案则只绑定；没权限、跨公司、重复绑定都拒绝', async () => {
    const bank = await svc.create(boss, 'bank-accounts', { kind: 'cashier_account', accountName: '建档用', bank: '测试银行', accountNo: '6222000000000077', reservedPhoneNumber: '13800138077', reservedPhoneHolder: '张三' });
    const r1 = await svc.createPhoneFor(boss, 'bank-accounts', bank.id);
    expect(r1.created).toBe(true);
    const after = await svc.get(boss, 'bank-accounts', bank.id);
    expect(after.data.phoneId).toBe(r1.phoneId);
    const phone = await svc.get(boss, 'phones', r1.phoneId);
    expect(phone.data.number).toBe('13800138077');
    expect(phone.data.externalUser).toBe('张三');
    await expect(svc.createPhoneFor(boss, 'bank-accounts', bank.id)).rejects.toThrow(/已经绑定/);
    const bank2 = await svc.create(boss, 'bank-accounts', { kind: 'cashier_account', accountName: '建档用2', bank: '测试银行', accountNo: '6222000000000078', reservedPhoneNumber: '13700137078' });
    const existingPhone = await svc.create(boss, 'phones', { number: '13700137078', usageType: 'external_used' });
    const bank2Now = await svc.get(boss, 'bank-accounts', bank2.id);
    if (bank2Now.data.phoneId) await svc.update(boss, 'bank-accounts', bank2.id, { phoneId: null });
    const r2 = await svc.createPhoneFor(boss, 'bank-accounts', bank2.id);
    expect(r2.created).toBe(false);
    expect(r2.phoneId).toBe(existingPhone.id);
    const limited: AuthUser = { ...boss, permissions: { isCompanyAdmin: false, allow: ['resource.bank-accounts.edit'], deny: [] } };
    const bank3 = await svc.create(boss, 'bank-accounts', { kind: 'cashier_account', accountName: '建档用3', bank: '测试银行', accountNo: '6222000000000079', reservedPhoneNumber: '13900139079' });
    await expect(svc.createPhoneFor(limited, 'bank-accounts', bank3.id)).rejects.toThrow(/权限/);
    await expect(svc.createPhoneFor(other, 'bank-accounts', bank3.id)).rejects.toThrow();
    await expect(svc.createPhoneFor(boss, 'licenses', 1)).rejects.toThrow(/没有可建档/);
  });

  it('证件号：可明文编辑和清除，没改时不会重复记日志，必填的卡号不能清空', async () => {
    const p = await svc.create(boss, 'partners', { name: '赵六', idNumber: '110101199001011234' });
    expect(p.data.idNumber).toBe('110101199001011234');
    const same = await svc.update(boss, 'partners', p.id, { name: '赵六', idNumber: '110101199001011234' });
    const logs1 = await svc.logs(boss, 'partners', same.id);
    expect(logs1.filter((l) => l.action === 'update' && l.note?.includes('证件号')).length).toBe(0);
    const changed = await svc.update(boss, 'partners', p.id, { idNumber: '110101199001015678' });
    expect(changed.data.idNumber).toBe('110101199001015678');
    const cleared = await svc.update(boss, 'partners', p.id, { idNumber: '' });
    expect(cleared.data.idNumber).toBeUndefined();
    const bank = await svc.create(boss, 'bank-accounts', { kind: 'cashier_account', accountName: '出纳', bank: '测试银行', accountNo: '6222000000000001' });
    await expect(svc.update(boss, 'bank-accounts', bank.id, { accountNo: '' })).rejects.toThrow(/账号\/卡号不能为空/);
    const logs = await svc.logs(boss, 'partners', p.id);
    expect(JSON.stringify(logs)).not.toContain('110101199001015678');
  });

  it('店铺经营数据：自动算利润和标题、同店同日唯一、按日期倒序分页、营收汇总', async () => {
    const lic = await svc.create(boss, 'licenses', { category: 'operation', companyName: '营收公司', creditCode: 'X-REV-1', legalPerson: '王五' });
    const store = await svc.create(boss, 'stores', { platform: 'pdd', name: '营收店', licenseId: lic.id });
    const noLic = await svc.create(boss, 'stores', { platform: 'jd', name: '无执照店' });
    const m = (day: string, sales: number) => ({ storeId: store.id, day, sales, refund: 100, adCost: 200, platformFee: 50, purchaseCost: 300, otherCost: 10, orders: 3 });
    const a = await svc.create(boss, 'store-daily-metrics', m('2026-10-01', 10000));
    expect(a.data.profit).toBe(10000 - 100 - 200 - 50 - 300 - 10);
    expect(a.data.source).toBe('manual');
    expect(a.title).toBe('营收店 2026-10-01');
    await expect(svc.create(boss, 'store-daily-metrics', m('2026-10-01', 1))).rejects.toThrow(/已经有经营数据/);
    await svc.create(boss, 'store-daily-metrics', m('2026-10-02', 20000));
    await svc.create(boss, 'store-daily-metrics', m('2026-10-03', 30000));
    await svc.create(boss, 'store-daily-metrics', { storeId: noLic.id, day: '2026-10-02', sales: 999 });
    const page1 = await svc.list(boss, 'store-daily-metrics', { fieldKey: 'storeId', fieldValue: String(store.id), page: 1, pageSize: 2 });
    expect(page1.total).toBe(3);
    expect(page1.items.map((i) => i.data.day)).toEqual(['2026-10-03', '2026-10-02']);
    const page2 = await svc.list(boss, 'store-daily-metrics', { fieldKey: 'storeId', fieldValue: String(store.id), page: 2, pageSize: 2 });
    expect(page2.items.map((i) => i.data.day)).toEqual(['2026-10-01']);
    const edited = await svc.update(boss, 'store-daily-metrics', a.id, { sales: 11000, profit: 1 });
    expect(edited.data.profit).toBe(11000 - 660);

    const rev = await buildServices(ds).revenue.licenseSummary(boss, lic.id, '2026-10-01', '2026-10-02');
    expect(rev.stores).toHaveLength(1);
    expect(rev.total.sales).toBe(11000 + 20000);
    expect(rev.total.orders).toBe(6);
    expect(rev.total.profit).toBe(11000 - 660 + 20000 - 660);
    await expect(buildServices(ds).revenue.licenseSummary(other, lic.id, '2026-10-01', '2026-10-02')).rejects.toThrow(/不存在/);
    await expect(buildServices(ds).revenue.licenseSummary(boss, lic.id, '2026-10-05', '2026-10-01')).rejects.toThrow(/不合法/);
  });

  it('店铺推广与评分：投产比自动算，导入时按店铺名匹配', async () => {
    const store = await svc.create(boss, 'stores', { platform: 'douyin', name: '推广店' });
    const p = await svc.create(boss, 'store-promotions', { storeId: store.id, day: '2026-10-01', campaign: '全站推广', spend: 1000, gmv: 4500 });
    expect(p.data.roiPercent).toBe(450);
    const z = await svc.create(boss, 'store-promotions', { storeId: store.id, day: '2026-10-01', campaign: '搜索', spend: 0, gmv: 10 });
    expect(z.data.roiPercent ?? null).toBeNull();
    const sc = await svc.create(boss, 'store-scores', { storeId: store.id, snapshotDate: '2026-10-01', dimension: 'experience', metric: '综合体验分', value: '4.8' });
    expect(sc.title).toContain('推广店');
    const res = await svc.importRows(boss, 'store-daily-metrics', [{ 店铺: '推广店', 日期: '2026-10-05', 销售额: '12.5' }], true);
    expect(res.failed).toBe(0);
    expect(res.results[0].title).toBe('推广店 2026-10-05');
  });
});
