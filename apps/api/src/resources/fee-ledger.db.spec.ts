/**
 * 费用模块（通信费用台账）：主子卡聚合、两级约束、宽带必须绑定手机号、宽带与区域、权限、公司隔离、记录充值。
 *   RESOURCE_DB_TEST=1 TEST_DB_NAME=<库> npx jest --runInBand fee-ledger
 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { addDaysText, todayShanghai } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { FeeLedgerService } from './fee-ledger.service';
import { GridSaveService } from './grid-save.service';
import { ResourcesService } from './resources.service';

const enabled = process.env.RESOURCE_DB_TEST === '1';
const d = enabled ? describe : describe.skip;

d('费用模块：通信费用台账（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let ledger: FeeLedgerService;
  let grid: GridSaveService;
  let boss: AuthUser;
  let other: AuthUser;
  const today = todayShanghai();
  const ids: Record<string, number> = {};

  const mkUser = async (companyId: number, account: string, admin: boolean): Promise<AuthUser> => {
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name: account, isCompanyAdmin: admin, status: 'active', mustChangePassword: false }));
    return { id: u.id, companyId, name: account, permissions: { isCompanyAdmin: admin, allow: [], deny: [] } };
  };

  beforeAll(async () => {
    const options = buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' });
    ds = new DataSource({ ...options, migrationsRun: true } as never);
    await ds.initialize();
    const services = buildServices(ds);
    svc = services.resources;
    ledger = new FeeLedgerService(ds);
    grid = new GridSaveService(svc);
    const code = () => `fl${crypto.randomBytes(4).toString('hex')}`;
    const c1 = await ds.manager.save(Company, ds.manager.create(Company, { code: code(), name: '费用公司', status: 'active' }));
    const c2 = await ds.manager.save(Company, ds.manager.create(Company, { code: code(), name: '别家公司', status: 'active' }));
    boss = await mkUser(c1.id, 'boss', true);
    other = await mkUser(c2.id, 'other', true);

    const phone = async (key: string, values: Record<string, unknown>) => { ids[key] = (await svc.create(boss, 'phones', { usageType: 'company_kept', carrier: '中国移动', ...values })).id; };
    await phone('m1', { number: '13800000001', plan: '商务主套餐', monthlyFee: 10000, feeCycle: 'monthly', lastRechargeAt: addDaysText(today, -25), rechargeCycleDays: 30 }); // 5 天后
    await phone('s1', { number: '13800000002', parentPhoneId: ids.m1, monthlyFee: 3000, feeCycle: 'monthly', lastRechargeAt: addDaysText(today, -40), rechargeCycleDays: 30 }); // 逾期
    await phone('s2', { number: '13800000003', parentPhoneId: ids.m1, monthlyFee: 36000, feeCycle: 'yearly' });
    await phone('m2', { number: '13800000004', carrier: '中国联通', monthlyFee: 9000, feeCycle: 'quarterly', lastRechargeAt: today, rechargeCycleDays: 90 });
    await phone('m3', { number: '13800000005' }); // 未设费用的独立号码
    ids.bb = (await svc.create(boss, 'broadband', { account: 'bb-main', phoneId: ids.m1, amount: 24000, cycle: 'yearly', expiresAt: addDaysText(today, 10) })).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('按主卡聚合：子卡挂在主卡下，主子合计折算月均，独立号码也在', async () => {
    const r = await ledger.ledger(boss, { view: 'main' });
    expect(r.total).toBe(3);
    const g = r.groups!.find((x) => x.main.number === '13800000001')!;
    expect(g.children.map((c) => c.number)).toEqual(['13800000002', '13800000003']);
    // 10000 + 3000 + 36000/12 = 16000
    expect(g.monthlyCents).toBe(16000);
    expect(g.main.broadband.map((b) => b.account)).toEqual(['bb-main']);
    expect(r.groups!.find((x) => x.main.number === '13800000005')!.children).toEqual([]);
    expect(r.summary).toMatchObject({ mainCount: 3, subCount: 2, overdueCount: 1, soonCount: 1, noFeeCount: 1, orphanCount: 0 });
    // 手机 16000 + 季付 9000/3 = 3000 → 19000；宽带年付 24000/12 = 2000 单独汇总
    expect(r.summary.phoneMonthlyCents).toBe(19000);
    expect(r.summary.broadbandMonthlyCents).toBe(2000);
    expect(r.summary.monthlyCents).toBe(21000);
  });

  it('筛选：逾期/7天内/未设费用/子卡；搜索子卡号时整组出现；分页在服务端', async () => {
    expect((await ledger.ledger(boss, { view: 'all', focus: 'overdue' })).rows!.map((x) => x.number)).toEqual(['13800000002']);
    expect((await ledger.ledger(boss, { view: 'all', focus: 'soon' })).rows!.map((x) => x.number)).toEqual(['13800000001']);
    expect((await ledger.ledger(boss, { view: 'all', focus: 'nofee' })).rows!.map((x) => x.number).sort()).toEqual(['13800000005']);
    expect((await ledger.ledger(boss, { view: 'all', focus: 'sub' })).total).toBe(2);
    expect((await ledger.ledger(boss, { view: 'all', carrier: '中国联通' })).rows!.map((x) => x.number)).toEqual(['13800000004']);
    const byChild = await ledger.ledger(boss, { view: 'main', q: '13800000003' });
    expect(byChild.groups!.map((x) => x.main.number)).toEqual(['13800000001']);
    const paged = await ledger.ledger(boss, { view: 'all', pageSize: 2, page: 2 });
    expect(paged.rows!.length).toBe(2);
    expect(paged.total).toBe(5);
  });

  it('下次充值日与手机号档案一致（最后充值 + 周期）', async () => {
    const r = await ledger.ledger(boss, { view: 'all' });
    expect(r.rows!.find((x) => x.number === '13800000001')!.nextRechargeAt).toBe(addDaysText(today, 5));
    expect(r.rows!.find((x) => x.number === '13800000004')!.nextRechargeAt).toBe(addDaysText(today, 90));
  });

  it('主子卡只允许两级：不能选自己、不能挂在子卡下、有子卡的不能再当子卡、别家公司的号码不行', async () => {
    await expect(svc.update(boss, 'phones', ids.m2, { parentPhoneId: ids.m2 })).rejects.toThrow(/不能选自己/);
    await expect(svc.update(boss, 'phones', ids.m2, { parentPhoneId: ids.s1 })).rejects.toThrow(/两级/);
    await expect(svc.update(boss, 'phones', ids.m1, { parentPhoneId: ids.m2 })).rejects.toThrow(/子卡/);
    await expect(svc.create(boss, 'phones', { number: '13800000099', usageType: 'company_kept', parentPhoneId: ids.s2 })).rejects.toThrow(/两级/);
    const foreign = (await svc.create(other, 'phones', { number: '13700000001', usageType: 'company_kept' })).id;
    await expect(svc.update(boss, 'phones', ids.m3, { parentPhoneId: foreign })).rejects.toThrow();
    // 合法：独立号码挂到主卡下，再取消
    await svc.update(boss, 'phones', ids.m3, { parentPhoneId: ids.m2 });
    expect((await svc.get(boss, 'phones', ids.m3)).data.cardKind).toMatch(/^子卡/);
    expect((await grid.save(boss, 'phones', { updates: [{ id: ids.m3, data: { parentPhoneId: null } }] })).results[0].ok).toBe(true);
  });

  it('停用的主卡下的子卡、以及指向停用/不存在主卡的子卡，列为孤立子卡', async () => {
    await svc.create(boss, 'phones', { number: '13800000010', usageType: 'company_kept', monthlyFee: 100 });
    const m = (await svc.list(boss, 'phones', { keyword: '13800000010' })).items[0];
    const sub = await svc.create(boss, 'phones', { number: '13800000011', usageType: 'company_kept', parentPhoneId: m.id });
    await svc.changeStatus(boss, 'phones', m.id, 'inactive', '停用');
    const r = await ledger.ledger(boss, { view: 'main' });
    expect(r.orphans!.map((x) => x.number)).toEqual(['13800000011']);
    expect(r.summary.orphanCount).toBe(1);
    expect(r.groups!.some((g) => g.children.some((c) => c.id === sub.id))).toBe(false);
    // 给孤立子卡补绑到一张正常主卡
    await svc.update(boss, 'phones', sub.id, { parentPhoneId: ids.m2 });
    expect((await ledger.ledger(boss, { view: 'main' })).summary.orphanCount).toBe(0);
  });

  it('宽带新建必须绑定手机号；历史没绑的可以编辑但在台账里标出；区域路径与按区域筛选', async () => {
    await expect(svc.create(boss, 'broadband', { account: 'bb-nophone' })).rejects.toThrow(/绑定手机号/);
    const building = (await svc.create(boss, 'locations', { name: '总部大楼', scope: 'area', locationType: 'building' })).id;
    const floor = (await svc.create(boss, 'locations', { name: '3楼', scope: 'area', locationType: 'floor', parentId: building })).id;
    const room = (await svc.create(boss, 'locations', { name: '运营室', scope: 'area', locationType: 'room', parentId: floor })).id;
    const b2 = await svc.create(boss, 'broadband', { account: 'bb-room', phoneId: ids.m2, locationId: room, amount: 5000, cycle: 'monthly' });
    // 历史数据：直接写库模拟没绑手机号的旧宽带
    const legacy = await svc.create(boss, 'broadband', { account: 'bb-legacy', phoneId: ids.m2 });
    await ds.query(`UPDATE resource_records SET data = JSON_REMOVE(data, '$.phoneId') WHERE id = ?`, [legacy.id]);
    await svc.update(boss, 'broadband', legacy.id, { amount: 100 }); // 不拦编辑
    const all = await ledger.ledger(boss, { view: 'broadband' });
    expect(all.summary).toMatchObject({ broadbandCount: 3, broadbandUnboundCount: 1, broadbandNoAreaCount: 2 });
    expect(all.broadband!.find((b) => b.account === 'bb-room')!.location).toBe('总部大楼 / 3楼 / 运营室');
    expect(all.broadband!.find((b) => b.account === 'bb-room')!.phoneNumber).toBe('13800000004');
    expect((await ledger.ledger(boss, { view: 'broadband', focus: 'unbound' })).broadband!.map((b) => b.account)).toEqual(['bb-legacy']);
    // 选上级区域包含下级
    expect((await ledger.ledger(boss, { view: 'broadband', location: building })).broadband!.map((b) => b.account)).toEqual(['bb-room']);
    expect((await ledger.ledger(boss, { view: 'broadband', focus: 'expiring' })).broadband!.map((b) => b.account)).toEqual(['bb-main']);
    // 房间详情的“关联”里反向看到该区域用的宽带
    const rel = await svc.relations(boss, 'locations', room, () => true);
    expect(JSON.stringify(rel)).toContain('bb-room');
    expect(b2.data.locationId).toBe(room);
  });

  it('与宽带资料是同一份数据：台账里改，资料里立即看到，反之亦然；操作记录写“费用模块”', async () => {
    const res = await grid.save(boss, 'broadband', { note: '费用模块', updates: [{ id: ids.bb, data: { amount: 12000, cycle: 'monthly' } }] });
    expect(res.results[0].ok).toBe(true);
    expect((await svc.get(boss, 'broadband', ids.bb)).data.amount).toBe(12000);
    await svc.update(boss, 'broadband', ids.bb, { amount: 6000 });
    const row = (await ledger.ledger(boss, { view: 'broadband' })).broadband!.find((b) => b.id === ids.bb)!;
    expect(row.amountCents).toBe(6000);
    const logs = await svc.logs(boss, 'broadband', ids.bb);
    expect(JSON.stringify(logs)).toContain('费用模块');
  });

  it('记录充值：最后充值日改为今天，下次充值日按周期推算；版本冲突不覆盖', async () => {
    const before = (await ledger.ledger(boss, { view: 'all' })).rows!.find((x) => x.id === ids.s1)!;
    expect(before.state).toBe('overdue');
    const stale = before.version;
    const ok = await grid.save(boss, 'phones', { note: '费用模块', updates: [{ id: ids.s1, version: stale, data: { lastRechargeAt: today } }] });
    expect(ok.results[0].ok).toBe(true);
    const after = (await ledger.ledger(boss, { view: 'all' })).rows!.find((x) => x.id === ids.s1)!;
    expect(after.nextRechargeAt).toBe(addDaysText(today, 30));
    expect(after.state).toBe('ok');
    const conflict = await grid.save(boss, 'phones', { updates: [{ id: ids.s1, version: stale, data: { monthlyFee: 1 } }] });
    expect(conflict.results[0]).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('公司隔离与权限：别家公司看不到本公司的号码；没有宽带查看权限就没有宽带数据', async () => {
    const theirs = await ledger.ledger(other, { view: 'all' });
    expect(theirs.rows!.map((x) => x.number)).toEqual(['13700000001']);
    expect(theirs.summary.broadbandCount).toBe(0);
    const phoneOnly: AuthUser = { ...boss, permissions: { isCompanyAdmin: false, allow: ['resource.phones.view'], deny: [] } };
    const r = await ledger.ledger(phoneOnly, { view: 'main' });
    expect(r.canSeeBroadband).toBe(false);
    expect(r.summary.broadbandCount).toBeNull();
    expect(r.summary.broadbandMonthlyCents).toBeUndefined();
    expect(r.groups!.every((g) => g.main.broadband.length === 0)).toBe(true);
    await expect(ledger.ledger(phoneOnly, { view: 'broadband' })).rejects.toThrow(/没有查看宽带/);
  });

  it('旧系统迁入：只有“下次充值日”的号码保留旧日期；历史宽带没绑手机号、旧主子卡关系不被新规则拦住', async () => {
    const created = await ds.transaction(async (em) => {
      em.queryRunner!.data.legacyImport = true;
      const sub = await svc.importRecord(em, boss, 'phones', { number: '13800000088', usageType: 'company_kept', nextRechargeAt: '2026-07-05', rechargeCycleDays: 30, parentPhoneId: ids.s1 });
      const bb = await svc.importRecord(em, boss, 'broadband', { account: 'bb-imported' });
      return { sub, bb };
    });
    expect(created.sub.data.nextRechargeAt).toBe('2026-07-05');
    expect(created.bb.data.phoneId).toBeUndefined();
    // 这条子卡的“主卡”本身是子卡，台账列为孤立子卡等人工整理
    const r = await ledger.ledger(boss, { view: 'main' });
    expect(r.orphans!.map((x) => x.number)).toContain('13800000088');
    expect((await ledger.ledger(boss, { view: 'broadband', focus: 'unbound' })).broadband!.map((b) => b.account)).toContain('bb-imported');
  });
});
