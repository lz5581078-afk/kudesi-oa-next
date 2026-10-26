/** 快递价格表（公司→网点→版本→规则、估价、分区建议）的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_b npx jest express.db */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { PROVINCES } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ExpressService } from './express.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('快递价格表（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let ex: ExpressService;
  let boss: AuthUser;
  const ids: Record<string, number> = {};
  const fixed = (price: number, province = 'ALL') => ({ province, shipWeightMin: 0, shipWeightMax: null, fixedPrice: price });

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    ex = new ExpressService(ds, svc);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `e${crypto.randomBytes(5).toString('hex')}`, name: '快递测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('省份清单含港澳台', () => {
    expect(PROVINCES).toEqual(expect.arrayContaining(['香港', '澳门', '台湾']));
    expect(PROVINCES.length).toBe(34);
  });

  it('层级：第一个网点自动成默认网点，第一个版本自动成当前版本；默认网点和当前版本必须是自己名下的', async () => {
    const jt = await svc.create(boss, 'finance-express-carriers', { name: '极兔' });
    await expect(svc.create(boss, 'finance-express-carriers', { name: '极兔' })).rejects.toThrow(/已存在/);
    const b1 = await svc.create(boss, 'finance-express-branches', { carrierId: jt.id, name: '兰山网点', jstLogisticsName: '淘宝-极兔小件' });
    await expect(svc.create(boss, 'finance-express-branches', { carrierId: jt.id, name: '兰山网点' })).rejects.toThrow(/同名网点/);
    expect((await svc.get(boss, 'finance-express-carriers', jt.id)).data.defaultBranchId).toBe(b1.id);
    const b2 = await svc.create(boss, 'finance-express-branches', { carrierId: jt.id, name: '郯城网点' });
    await svc.update(boss, 'finance-express-carriers', jt.id, { defaultBranchId: b2.id });
    expect((await svc.get(boss, 'finance-express-carriers', jt.id)).data.defaultBranchId).toBe(b2.id);
    const zt = await svc.create(boss, 'finance-express-carriers', { name: '中通' });
    const zb = await svc.create(boss, 'finance-express-branches', { carrierId: zt.id, name: '总部' });
    await expect(svc.update(boss, 'finance-express-carriers', jt.id, { defaultBranchId: zb.id })).rejects.toThrow(/下的网点/);
    const v1 = await svc.create(boss, 'finance-express-versions', { branchId: b1.id, versionName: '2026春', shippingWeightMax: 30 });
    expect((await svc.get(boss, 'finance-express-branches', b1.id)).data.currentVersionId).toBe(v1.id);
    expect(v1.data.cooperationStatus).toBe('pending');
    await expect(svc.create(boss, 'finance-express-versions', { branchId: b1.id, versionName: '2026春' })).rejects.toThrow(/同名价格版本/);
    const v2 = await svc.create(boss, 'finance-express-versions', { branchId: b1.id, versionName: '2026秋' });
    const zv = await svc.create(boss, 'finance-express-versions', { branchId: zb.id, versionName: 'v1' });
    await expect(svc.update(boss, 'finance-express-branches', b1.id, { currentVersionId: zv.id })).rejects.toThrow(/下的版本/);
    Object.assign(ids, { jt: jt.id, b1: b1.id, b2: b2.id, zt: zt.id, zb: zb.id, v1: v1.id, v2: v2.id, zv: zv.id });
  });

  it('价格规则：挂版本后快递公司/网点/可发货范围由层级带出；只有“当前版本 + 合作中”的规则才是启用状态', async () => {
    const r = await svc.create(boss, 'finance-express-prices', { versionId: ids.v1, province: '广东', shipWeightMin: 0, fixedPrice: 800 });
    expect(r.data.carrier).toBe('极兔');
    expect(r.data.branch).toBe('兰山网点');
    expect(r.data.limitMax).toBe(30);
    expect(r.status).toBe('inactive'); // 还是“待确认”，不参与预估
    await expect(svc.create(boss, 'finance-express-prices', { versionId: ids.v1, province: '广东' })).rejects.toThrow(/固定价/);
    await expect(svc.create(boss, 'finance-express-prices', { versionId: ids.v1, province: '广东', firstWeight: 2, firstPrice: 500 })).rejects.toThrow(/0 或 1/);
    await expect(svc.create(boss, 'finance-express-prices', { province: '广东', fixedPrice: 100 })).rejects.toThrow(/价格版本/);
    await svc.update(boss, 'finance-express-versions', ids.v1, { cooperationStatus: 'active' });
    expect((await svc.get(boss, 'finance-express-prices', r.id)).status).toBe('active');
    // 换当前版本：旧版本规则停用
    await svc.update(boss, 'finance-express-versions', ids.v2, { cooperationStatus: 'active' });
    await svc.update(boss, 'finance-express-branches', ids.b1, { currentVersionId: ids.v2 });
    expect((await svc.get(boss, 'finance-express-prices', r.id)).status).toBe('inactive');
    await svc.update(boss, 'finance-express-branches', ids.b1, { currentVersionId: ids.v1 });
    expect((await svc.get(boss, 'finance-express-prices', r.id)).status).toBe('active');
    // 暂停合作
    await svc.update(boss, 'finance-express-versions', ids.v1, { cooperationStatus: 'paused' });
    expect((await svc.get(boss, 'finance-express-prices', r.id)).status).toBe('inactive');
    await svc.update(boss, 'finance-express-versions', ids.v1, { cooperationStatus: 'active' });
  });

  it('整表保存：AI 和手工两套价格并存，只有“最终价格依据”那套生效；港澳台可以报价', async () => {
    const r = await ex.replaceRules(boss, ids.v1, 'manual', [fixed(1000), fixed(2000, '新疆'), fixed(5000, '香港')], '测试');
    expect(r).toEqual({ created: 3, removed: 1 });
    await ex.replaceRules(boss, ids.v1, 'ai', [fixed(900)], '测试');
    let detail = await ex.versionDetail(boss, ids.v1);
    expect(detail.rules.length).toBe(4);
    expect(detail.effectiveSource).toBe('manual');
    const active = async () => (await svc.list(boss, 'finance-express-prices', { status: 'active', pageSize: 100 })).items.filter((x) => x.data.versionId === ids.v1);
    expect((await active()).length).toBe(3);
    await svc.update(boss, 'finance-express-versions', ids.v1, { priceSource: 'ai' });
    expect((await active()).map((x) => x.data.fixedPrice)).toEqual([900]);
    await svc.update(boss, 'finance-express-versions', ids.v1, { priceSource: 'manual' });
    detail = await ex.versionDetail(boss, ids.v1);
    expect(detail.rules.filter((x) => x.source === 'manual').length).toBe(3);
    await expect(ex.replaceRules(boss, ids.v1, 'manual', [{ province: '广东', shipWeightMin: 5, shipWeightMax: 1, fixedPrice: 1 }], '测试')).rejects.toThrow(/第 1 条/);
  });

  it('预估运费一览：连续重量段、单包上限 1~100 可配、手工金额对拆包同样生效', async () => {
    // 5 家公司给全国统一价
    for (const [i, p] of [800, 820, 840, 860, 880].entries()) {
      const c = await svc.create(boss, 'finance-express-carriers', { name: `估价${i}` });
      const b = await svc.create(boss, 'finance-express-branches', { carrierId: c.id, name: '网点' });
      const v = await svc.create(boss, 'finance-express-versions', { branchId: b.id, versionName: 'v', cooperationStatus: 'active' });
      await ex.replaceRules(boss, v.id, 'manual', [fixed(p)], '测试');
    }
    const est = await ex.getEstimates(boss);
    expect(est.parcelLimit).toBe(30);
    expect(est.cooperatingGroups).toBeGreaterThanOrEqual(6);
    const first = est.rows.find((r) => r.key === '0-0.5')!;
    expect(first.autoAmount).toBeGreaterThan(0);
    expect(est.rows.some((r) => r.end === 1000)).toBe(true);
    const twoParcels = est.rows.find((r) => r.end === 31 || r.key === '30-31')!;
    expect(twoParcels.method).toBe('split_parcel_sum');
    await expect(ex.setParcelLimit(boss, 0)).rejects.toThrow(/1 到 100/);
    await expect(ex.setParcelLimit(boss, 101)).rejects.toThrow(/1 到 100/);
    const small = await ex.setParcelLimit(boss, 10);
    expect(small.parcelLimit).toBe(10);
    expect(small.rows.find((r) => r.key === '9-10')).toBeTruthy();
    expect(small.rows.find((r) => r.key === '29-30')!.method).toBe('split_parcel_sum'); // 超过单包上限的都是拆包段
    // 手工金额：必须是标准段；对拆包生效（11~12kg = 10kg + 2kg）
    await expect(ex.setOverride(boss, 1, 3, 100)).rejects.toThrow(/标准重量段/);
    const before = small.rows.find((r) => r.key === '1-2')!;
    const o = await ex.setOverride(boss, 1, 2, 5000, '促销');
    expect(o.rows.find((r) => r.key === '1-2')!.manualAmount).toBe(5000);
    const split = o.rows.find((r) => r.key === '11-12')!;
    expect(split.parcels!.map((p) => p.amount)).toEqual([o.rows.find((r) => r.key === '9-10')!.autoAmount, 5000]);
    expect(split.autoAmount).toBe((o.rows.find((r) => r.key === '9-10')!.autoAmount as number) + 5000);
    expect(before.autoAmount).not.toBe(5000);
    expect(o.calculatedAt).toBeTruthy();
    const back = await ex.setOverride(boss, 1, 2, null);
    expect(back.rows.find((r) => r.key === '1-2')!.manualAmount).toBeNull();
    await ex.setParcelLimit(boss, 30);
  });

  it('分区建议：生成一次留一条记录，可翻看；没有合作中的版本时拒绝', async () => {
    const run = await ex.generateZoneRun(boss, 5);
    expect(run.sequence).toBe(1);
    const run2 = await ex.generateZoneRun(boss, 10);
    expect(run2.sequence).toBe(2);
    const list = await ex.listZoneRuns(boss, 1, 5);
    expect(list.total).toBe(2);
    expect(list.items[0].sequence).toBe(2);
    const detail = await ex.getZoneRun(boss, run.id);
    expect(detail.rules.length).toBe(run.ruleCount);
    expect((detail.rules[0] as { provinces: string[] }).provinces.length).toBeGreaterThan(0);
    await expect(ex.generateZoneRun(boss, 0)).rejects.toThrow(/0 到 1000/);
    await ex.deleteZoneRun(boss, run.id);
    expect((await ex.listZoneRuns(boss, 1, 5)).total).toBe(1);
  });

  it('确认 AI 识别：替换 AI 价格、价格依据改为 AI、补全有效期和备注、留识别记录；加收通知存成批次', async () => {
    const c = await svc.create(boss, 'finance-express-carriers', { name: '识别快递' });
    const b = await svc.create(boss, 'finance-express-branches', { carrierId: c.id, name: '识别网点' });
    const v = await svc.create(boss, 'finance-express-versions', { branchId: b.id, versionName: '识别版', cooperationStatus: 'active' });
    const res = await ex.confirmPriceRecognition(boss, v.id, { rules: [{ province: '广东', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: 300 }, { province: '广东', shipWeightMin: 1, firstWeight: 1, firstPrice: 300, extraPrice: 100 }], fileName: '价格表.png', modelName: 'm1', effectiveStart: '2026-01-01', extraRemark: '退改费用：10元' });
    expect(res.created).toBe(2);
    const detail = await ex.versionDetail(boss, v.id);
    expect(detail.version.data.priceSource).toBe('ai');
    expect(detail.version.data.effectiveStart).toBe('2026-01-01');
    expect(String(detail.version.data.remark)).toContain('退改费用：10元');
    expect(detail.recognitions).toHaveLength(1);
    expect(detail.rules.every((x) => x.source === 'ai')).toBe(true);
    const sur = await ex.confirmSurchargeRecognition(boss, v.id, { batchName: '广东加收', rows: [{ name: '偏远', chargeType: 'fixed', amount: 200, areaScope: '广东' }, { name: '旺季', chargeType: 'percent', percent: 8, areaScope: '全部省份' }], fileName: '通知.png' });
    expect(sur.created).toBe(2);
    const d2 = await ex.versionDetail(boss, v.id);
    expect(d2.batches).toHaveLength(1);
    expect(d2.surcharges).toHaveLength(2);
    await expect(ex.confirmSurchargeRecognition(boss, v.id, { batchName: 'x', rows: [{ name: '坏', chargeType: 'fixed' }] })).rejects.toThrow(/第 1 条加收/);
    expect((await ex.versionDetail(boss, v.id)).batches).toHaveLength(1); // 失败整体回滚
  });

  it('加收：按方式校验金额；停用批次会停掉批次下的加收；删批次级联', async () => {
    const batch = await svc.create(boss, 'finance-express-fee-batches', { versionId: ids.v1, batchName: '新疆西藏加收', source: 'manual' });
    await expect(svc.create(boss, 'finance-express-surcharges', { versionId: ids.v1, batchId: batch.id, name: '新疆加收', chargeType: 'fixed' })).rejects.toThrow(/加收金额/);
    await expect(svc.create(boss, 'finance-express-surcharges', { versionId: ids.v1, batchId: batch.id, name: '比例', chargeType: 'percent' })).rejects.toThrow(/比例/);
    await expect(svc.create(boss, 'finance-express-surcharges', { versionId: ids.v1, batchId: batch.id, name: '区间', chargeType: 'fixed', amount: 100, weightMode: 'between', weightStart: 5, weightEnd: 2 })).rejects.toThrow(/区间重量/);
    const s = await svc.create(boss, 'finance-express-surcharges', { versionId: ids.v1, batchId: batch.id, name: '新疆加收', chargeType: 'per_kg', amount: 150, areaScope: '新疆', weightMode: 'above', weightStart: 1 });
    await svc.changeStatus(boss, 'finance-express-fee-batches', batch.id, 'stopped', '通知过期');
    expect((await svc.get(boss, 'finance-express-surcharges', s.id)).status).toBe('stopped');
    await ex.deleteSurchargeBatch(boss, batch.id, '测试删除');
    await expect(svc.get(boss, 'finance-express-surcharges', s.id)).rejects.toThrow(/不存在/);
  });

  it('级联删除：删版本清空规则并解除网点当前版本；删网点/公司连带下级，默认网点自动顺延', async () => {
    await expect(svc.remove(boss, 'finance-express-versions', ids.v1, '直接删')).rejects.toThrow(/引用/);
    await ex.deleteVersion(boss, ids.v1, '测试级联');
    expect((await svc.get(boss, 'finance-express-branches', ids.b1)).data.currentVersionId).toBeUndefined();
    expect((await svc.list(boss, 'finance-express-prices', { pageSize: 200 })).items.filter((x) => x.data.versionId === ids.v1)).toEqual([]);
    // 默认网点是 b2；删 b2 后顺延到 b1
    await ex.deleteBranch(boss, ids.b2, '测试');
    expect((await svc.get(boss, 'finance-express-carriers', ids.jt)).data.defaultBranchId).toBe(ids.b1);
    await ex.deleteCarrier(boss, ids.jt, '测试');
    await expect(svc.get(boss, 'finance-express-branches', ids.b1)).rejects.toThrow(/不存在/);
    await expect(svc.get(boss, 'finance-express-versions', ids.v2)).rejects.toThrow(/不存在/);
  });

  it('老规则（没挂版本，直接填快递公司）仍然可用，参与估价', async () => {
    const before = (await ex.getEstimates(boss)).cooperatingGroups;
    await svc.create(boss, 'finance-express-prices', { carrier: '老规则快递', province: 'ALL', fixedPrice: 500 });
    expect((await ex.getEstimates(boss)).cooperatingGroups).toBe(before + 1);
  });
});
