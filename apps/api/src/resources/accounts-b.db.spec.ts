/**
 * B 组（店铺与账号）资料规则的真实数据库测试。需要：
 *   RESOURCE_DB_TEST=1 TEST_DB_NAME=<库> npx jest --runInBand accounts-b
 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const enabled = process.env.RESOURCE_DB_TEST === '1';
const d = enabled ? describe : describe.skip;

d('店铺与账号资料（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let opId: number;

  beforeAll(async () => {
    const options = buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' });
    ds = new DataSource({ ...options, migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `tb${crypto.randomBytes(4).toString('hex')}`, name: '测试公司B', status: 'active' }));
    const admin = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    const op = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'op', passwordHash: 'x', name: '小运营', status: 'active', mustChangePassword: false, isCompanyAdmin: false }));
    boss = { id: admin.id, companyId: company.id, name: 'boss', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    opId = op.id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('只选手机号档案、不填号码文本：绑定保留，号码文本自动带出（店铺/自媒体/微信）', async () => {
    const ph = await svc.create(boss, 'phones', { number: '13700000001', usageType: 'company_kept' });
    const st = await svc.create(boss, 'stores', { platform: 'pdd', name: '档案店', phoneId: ph.id });
    expect(st.data.phoneId).toBe(ph.id);
    expect(st.data.phoneNumber).toBe('13700000001');
    const sm = await svc.create(boss, 'self-media', { platform: 'douyin', name: '号1', phoneId: ph.id });
    expect(sm.data.phoneId).toBe(ph.id);
    const wx = await svc.create(boss, 'wechat', { name: '微信1', wechatNo: 'wx_b1', phoneId: ph.id });
    expect(wx.data.phoneNumber).toBe('13700000001');
    // 改名不丢绑定
    const again = await svc.update(boss, 'stores', st.id, { name: '档案店2' });
    expect(again.data.phoneId).toBe(ph.id);
    // 换档案：号码文本跟着换
    const ph2 = await svc.create(boss, 'phones', { number: '13700000002', usageType: 'company_kept' });
    const sw = await svc.update(boss, 'stores', st.id, { phoneId: ph2.id });
    expect(sw.data.phoneId).toBe(ph2.id);
    expect(sw.data.phoneNumber).toBe('13700000002');
    // 清空选择器 = 取消绑定
    const cleared = await svc.update(boss, 'stores', st.id, { phoneId: null });
    expect(cleared.data.phoneId).toBeUndefined();
    expect(cleared.data.phoneNumber).toBeUndefined();
  });

  it('店铺一店多手机号：同平台同手机号只能绑一个店铺（含“更多手机号”）', async () => {
    const a = await svc.create(boss, 'phones', { number: '13700001001', usageType: 'company_kept' });
    const b = await svc.create(boss, 'phones', { number: '13700001002', usageType: 'company_kept' });
    const s1 = await svc.create(boss, 'stores', { platform: 'jd', name: '多号店', phoneId: a.id, phoneIds: [b.id] });
    expect(s1.data.phoneIds).toEqual([b.id]);
    await expect(svc.create(boss, 'stores', { platform: 'jd', name: '抢号店', phoneId: b.id })).rejects.toThrow(/已绑定了其他店铺/);
    const other = await svc.create(boss, 'stores', { platform: 'taobao', name: '别平台', phoneId: b.id });
    expect(other.id).toBeGreaterThan(0);
  });

  it('店铺领取：指派必须有运营人，推广限制必须有解除日；批量只给运营人自动变已领取；收回为公共清空运营人', async () => {
    await expect(svc.create(boss, 'stores', { platform: 'pdd', name: '无人店', claimStatus: 'reserved' })).rejects.toThrow(/必须选择运营人/);
    await expect(svc.create(boss, 'stores', { platform: 'pdd', name: '限制店', claimStatus: 'promotion_limited', operatorUserId: opId })).rejects.toThrow(/解除日期/);
    const pub = await svc.create(boss, 'stores', { platform: 'pdd', name: '公共店' });
    expect(pub.data.claimStatus).toBe('public');
    const r = await svc.batchUpdate(boss, 'stores', [pub.id], { operatorUserId: opId });
    expect(r.done).toBe(1);
    const got = await svc.get(boss, 'stores', pub.id);
    expect(got.data.claimStatus).toBe('claimed');
    expect(got.data.operatorUserId).toBe(opId);
    await svc.batchUpdate(boss, 'stores', [pub.id], { claimStatus: 'public' });
    expect((await svc.get(boss, 'stores', pub.id)).data.operatorUserId).toBeUndefined();
  });

  it('异常原因：改异常必须填原因，自由输入自动记入原因库，同名复用', async () => {
    const s = await svc.create(boss, 'stores', { platform: 'xhs', name: '异常店' });
    await expect(svc.changeStatus(boss, 'stores', s.id, 'abnormal', undefined)).rejects.toThrow(/必须填写原因/);
    const ab = await svc.changeStatus(boss, 'stores', s.id, 'abnormal', '被平台限流');
    expect(ab.refLabels.abnormalReason).toBe('被平台限流');
    const lib = await svc.list(boss, 'store-abnormal-reasons', { keyword: '限流' });
    expect(lib.total).toBe(1);
    const s2 = await svc.create(boss, 'stores', { platform: 'xhs', name: '异常店2' });
    await svc.changeStatus(boss, 'stores', s2.id, 'abnormal', '被平台限流');
    expect((await svc.list(boss, 'store-abnormal-reasons', { keyword: '限流' })).total).toBe(1);
    // 手机号同理
    const ph = await svc.create(boss, 'phones', { number: '13700002001', usageType: 'company_kept' });
    expect(ph.data.carrier).toBe('中国移动');
    const pa = await svc.changeStatus(boss, 'phones', ph.id, 'abnormal', '停机欠费');
    expect(pa.refLabels.abnormalReason).toBe('停机欠费');
    // 自媒体：文本原因
    const sm = await svc.create(boss, 'self-media', { platform: 'xhs', name: '异常号' });
    const sma = await svc.changeStatus(boss, 'self-media', sm.id, 'abnormal', '封号');
    expect(sma.data.abnormalReason).toBe('封号');
  });

  it('自媒体一号多店', async () => {
    const a = await svc.create(boss, 'stores', { platform: 'douyin', name: '关联店A' });
    const b = await svc.create(boss, 'stores', { platform: 'douyin', name: '关联店B' });
    const sm = await svc.create(boss, 'self-media', { platform: 'douyin', name: '多店号', storeId: a.id, storeIds: [b.id, a.id] });
    expect(sm.data.storeId).toBe(a.id);
    expect(sm.data.storeIds).toEqual([b.id]);
  });

  it('导入：店铺按 店铺编号+店铺名 有则更新，软件按 名称+账号 去重', async () => {
    const rows = [{ 平台: '拼多多', 店铺名: '导入店', 店铺编号: 'IM-1', 备注: '第一次' }];
    const first = await svc.importRows(boss, 'stores', rows, false);
    expect(first.created).toBe(1);
    const second = await svc.importRows(boss, 'stores', [{ ...rows[0], 备注: '第二次' }], false);
    expect(second.updated).toBe(1);
    expect((await svc.list(boss, 'stores', { keyword: '导入店' })).total).toBe(1);
    await svc.create(boss, 'software', { name: '钉钉', account: 'a@x.com' });
    await expect(svc.create(boss, 'software', { name: '钉钉', account: 'a@x.com' })).rejects.toThrow(/已经登记过/);
  });
});
