/** 对齐旧程序的资料规则：印章联动、银行预留手机自动关联、按账号去重、保管人二选一、执照自动建档的账户类型与复用。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('资料规则（对齐旧程序）', () => {
  let ds: DataSource;
  let svc: ReturnType<typeof buildServices>['resources'];
  let boss: AuthUser;
  const lic = (n: string, extra: Record<string, unknown> = {}) => ({ category: 'operation', companyName: `对齐公司${n}`, creditCode: `91310000AL${n}`, legalPerson: `法人${n}`, ...extra });

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `g${crypto.randomBytes(5).toString('hex')}`, name: '对齐', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds.destroy(); });

  it('印章联动：缺失清空种类和位置；普通章在位强制自刻；自刻章强制普通章在位', async () => {
    const r = await svc.create(boss, 'licenses', lic('01', {
      officialState: 'missing', officialKind: 'anti_fake', officialLocation: '柜子',
      financeState: 'ordinary_kept', financeKind: 'anti_fake',
      legalKind: 'self_carved', legalState: 'kept',
    }));
    expect(r.data.officialKind).toBeUndefined();
    expect(r.data.officialLocation).toBeUndefined();
    expect(r.data.financeKind).toBe('self_carved');
    expect(r.data.legalState).toBe('ordinary_kept');
  });

  it('执照自动建档：电商执照建店铺公户和店铺个人卡，同账号不重复建；同名法人只建一份合作人', async () => {
    await svc.create(boss, 'licenses', lic('02', { category: 'ecommerce', publicAccountNo: '6000000000000002', publicAccountBank: '工行', legalCardNo: '6000000000000003', legalCardBank: '建行' }));
    const pub = await svc.list(boss, 'bank-accounts', { tab: 'store_public' });
    const card = await svc.list(boss, 'bank-accounts', { tab: 'store_personal_card' });
    expect(pub.total).toBe(1);
    expect(card.total).toBe(1);
    // 另一个执照用同一个公户账号：不重复建
    await svc.create(boss, 'licenses', lic('03', { category: 'ecommerce', legalPerson: '法人02', publicAccountNo: '6000000000000002', publicAccountBank: '工行' }));
    expect((await svc.list(boss, 'bank-accounts', { tab: 'store_public' })).total).toBe(1);
    const partners = await svc.list(boss, 'partners', { keyword: '法人02' });
    expect(partners.total).toBe(1);
    expect(partners.items[0].data.partnerType).toBe('legal');
  });

  it('银行账户：同账号不能重复；预留手机号自动关联手机号档案；开户行必填', async () => {
    const phone = await svc.create(boss, 'phones', { number: '13900001111', usageType: 'company_kept' });
    const a = await svc.create(boss, 'bank-accounts', { kind: 'cashier_account', accountName: '出纳', bank: '招行', accountNo: '6000000000000010', reservedPhoneNumber: '139-0000-1111' });
    expect(a.data.phoneId).toBe(phone.id);
    await expect(svc.create(boss, 'bank-accounts', { kind: 'company_card', accountName: '重复', bank: '招行', accountNo: '6000000000000010' })).rejects.toThrow(/已存在/);
    await expect(svc.create(boss, 'bank-accounts', { kind: 'company_card', accountName: '缺行', accountNo: '6000000000000011' })).rejects.toThrow(/开户行不能为空/);
  });

  it('手机号保管人：选了员工就清掉手填姓名', async () => {
    const p = await svc.create(boss, 'phones', { number: '13900002222', usageType: 'company_kept', keeperName: '临时小王' });
    expect(p.data.keeperName).toBe('临时小王');
    const q = await svc.update(boss, 'phones', p.id, { keeperUserId: boss.id });
    expect(q.data.keeperName).toBeUndefined();
  });

  it('档案编号唯一', async () => {
    await svc.create(boss, 'archives', { archiveNo: 'ARCH-1', name: '合同柜' });
    await expect(svc.create(boss, 'archives', { archiveNo: 'ARCH-1', name: '另一个' })).rejects.toThrow(/已存在/);
  });

  it('导入前自动备份，恢复后回到导入前的样子；预览不留备份', async () => {
    const a = await svc.create(boss, 'phones', { number: '13700000001', usageType: 'company_kept', carrier: '移动' });
    await svc.importRows(boss, 'phones', [{ 号码: '13700000001', 使用类型: '公司保存', 运营商: '联通' }], true);
    expect(await svc.listImportBackups(boss, 'phones')).toHaveLength(0);
    const res = await svc.importRows(boss, 'phones', [
      { 号码: '13700000001', 使用类型: '公司保存', 运营商: '联通' },
      { 号码: '13700000002', 使用类型: '公司保存', 运营商: '电信' },
    ], false);
    expect(res.committed).toBe(true);
    expect((await svc.get(boss, 'phones', a.id)).data.carrier).toBe('联通');
    const backups = await svc.listImportBackups(boss, 'phones');
    expect(backups).toHaveLength(1);
    const r = await svc.restoreImportBackup(boss, 'phones', backups[0].id);
    expect(r.removed).toBe(1);
    expect((await svc.get(boss, 'phones', a.id)).data.carrier).toBe('移动');
    expect((await svc.list(boss, 'phones', { keyword: '13700000002' })).total).toBe(0);
  });

  it('执照总位置变更：正本、副本位置为空或等于旧总位置时跟着改', async () => {
    const r1 = await svc.create(boss, 'locations', { name: '一号柜', scope: 'area' });
    const r2 = await svc.create(boss, 'locations', { name: '二号柜', scope: 'area' });
    const l = await svc.create(boss, 'licenses', lic('09', { locationId: r1.id }));
    expect(l.data.originalLocationId).toBe(r1.id);
    const moved = await svc.update(boss, 'licenses', l.id, { locationId: r2.id });
    expect(moved.data.originalLocationId).toBe(r2.id);
    expect(moved.data.copyLocationId).toBe(r2.id);
  });

  it('手动关联：一条可以关联多条；保存不会冲掉；重复/自己/无权限不行；删除资料时一并清掉', async () => {
    const all = (() => true) as (p: string) => boolean;
    const p = await svc.create(boss, 'partners', { name: '多关联合作人' });
    const l1 = await svc.create(boss, 'licenses', lic('21'));
    const l2 = await svc.create(boss, 'licenses', lic('22'));
    await svc.addManualLink(boss, 'partners', p.id, 'licenses', l1.id, all);
    await svc.addManualLink(boss, 'partners', p.id, 'licenses', l2.id, all);
    await expect(svc.addManualLink(boss, 'partners', p.id, 'licenses', l1.id, all)).rejects.toThrow(/已经关联/);
    await expect(svc.addManualLink(boss, 'licenses', l1.id, 'partners', p.id, all)).rejects.toThrow(/已经关联/); // 反方向也算重复
    await expect(svc.addManualLink(boss, 'partners', p.id, 'partners', p.id, all)).rejects.toThrow(/不能关联自己/);
    await expect(svc.addManualLink(boss, 'partners', p.id, 'licenses', l1.id, () => false)).rejects.toThrow();
    await svc.update(boss, 'partners', p.id, { phone: '13900000021' }); // 保存后手动关联仍在
    const rels = await svc.relations(boss, 'partners', p.id, all);
    expect(rels.filter((r) => r.relation === 'manual')).toHaveLength(2);
    const back = await svc.relations(boss, 'licenses', l1.id, all);
    expect(back.some((r) => r.relation === 'manual' && r.title === '多关联合作人')).toBe(true);
    const link = rels.find((r) => r.relation === 'manual')!;
    await svc.removeManualLink(boss, 'partners', p.id, link.linkId!);
    expect((await svc.relations(boss, 'partners', p.id, all)).filter((r) => r.relation === 'manual')).toHaveLength(1);
    // 被手动关联的资料可以删除（不算引用），删除后关联消失
    const keep = (await svc.relations(boss, 'partners', p.id, all)).find((r) => r.relation === 'manual')!;
    for (const t of ['partners', 'tax-profiles']) for (const dep of (await svc.list(boss, t, { fieldKey: 'licenseId', fieldValue: String(keep.id), showHidden: true })).items) await svc.remove(boss, t, dep.id, '清理');
    await svc.remove(boss, 'licenses', keep.id, '测试');
    expect((await svc.relations(boss, 'partners', p.id, all)).filter((r) => r.relation === 'manual')).toHaveLength(0);
  });

  it('固定资产：分类自定义属性、所属部门；店铺领取状态联动；自媒体按平台带属性', async () => {
    const dept = (await ds.query('INSERT INTO departments (company_id, name, sort_order) VALUES (?, ?, 0)', [boss.companyId, '资产部'])).insertId as number;
    const cat = await svc.create(boss, 'asset-categories', { name: '手机', customFields: '颜色,容量' });
    const a = await svc.create(boss, 'fixed-assets', { assetNo: 'FA-ATTR-1', customAssetNo: 'MY-001', name: '测试机', categoryId: cat.id, departmentId: dept, attrs: { 颜色: '黑', 容量: '256G', 空的: '' } });
    expect(a.data.attrs).toEqual({ 颜色: '黑', 容量: '256G' });
    expect(a.refLabels.departmentId).toBe('资产部');
    await expect(svc.create(boss, 'fixed-assets', { assetNo: 'FA-ATTR-2', name: 'x', departmentId: 999999 })).rejects.toThrow(/部门不存在/);
    // 店铺：没填领取状态且没有运营人 → 公共店铺；有运营人 → 已领取
    const s1 = await svc.create(boss, 'stores', { platform: 'pdd', name: '公共店' });
    expect(s1.data.claimStatus).toBe('public');
    const s2 = await svc.create(boss, 'stores', { platform: 'pdd', name: '领取店', claimStatus: 'claimed', operatorUserId: boss.id });
    expect(s2.data.operatorUserId).toBe(boss.id);
    const s3 = await svc.update(boss, 'stores', s2.id, { claimStatus: 'public' });
    expect(s3.data.operatorUserId).toBeUndefined();
    // 自媒体：平台属性只保留当前平台的
    const m = await svc.create(boss, 'self-media', { platform: 'douyin', name: '抖号', douyinShopId: 'D1', redBookId: 'X1', promotionFeeBalance: 12345 });
    expect(m.data.douyinShopId).toBe('D1');
    expect(m.data.redBookId).toBeUndefined();
    expect(m.data.promotionFeeBalance).toBe(12345);
  });
});
