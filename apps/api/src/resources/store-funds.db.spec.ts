import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';
import { applyStoreFundBackfill, planStoreFundBackfill } from './store-funds';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('店铺资金口径：以最新资金快照为准（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let other: AuthUser;

  const mkUser = async (name: string): Promise<AuthUser> => {
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `x${crypto.randomBytes(5).toString('hex')}`, name, status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `sf${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    return { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  };
  const mkStore = (u: AuthUser, name: string) => svc.create(u, 'stores', { name, platform: 'pdd', storeNo: `S${crypto.randomBytes(3).toString('hex')}` });

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    boss = await mkUser('资金口径甲');
    other = await mkUser('资金口径乙');
  });
  afterAll(async () => { await ds?.destroy(); });

  it('店铺档案的四个资金字段只读：提交的值被忽略，显示最新快照；没有快照就是空；列表和详情一致；别家公司的快照不串', async () => {
    const a = await mkStore(boss, '口径店A');
    const b = await mkStore(boss, '口径店B');
    const o = await mkStore(other, '口径他家店');
    const edited = await svc.update(boss, 'stores', a.id, { deposit: 999, goodsFund: 888, frozen: 7, promotionBalance: 6, fundNote: '备注可改' });
    expect(edited.data.deposit).toBeUndefined();
    expect(edited.data.fundNote).toBe('备注可改');
    await svc.create(boss, 'store-funds', { storeId: a.id, snapshotDate: '2026-03-01', withdrawable: 100, deposit: 200, frozen: 300, promotion: 400 });
    await svc.create(boss, 'store-funds', { storeId: a.id, snapshotDate: '2026-03-09', withdrawable: 1000, deposit: 2000, frozen: 3000, promotion: 4000 });
    await svc.create(boss, 'store-funds', { storeId: a.id, snapshotDate: '2026-02-01', withdrawable: 1, deposit: 1, frozen: 1, promotion: 1 }); // 补录更早的一天，不影响“最新”
    await svc.create(other, 'store-funds', { storeId: o.id, snapshotDate: '2026-04-01', withdrawable: 5, deposit: 5, frozen: 5, promotion: 5 });
    const got = await svc.get(boss, 'stores', a.id);
    expect(got.data).toMatchObject({ deposit: 2000, frozen: 3000, goodsFund: 1000, promotionBalance: 4000 });
    const listed = (await svc.list(boss, 'stores', { page: 1, pageSize: 50 })).items;
    expect(listed.find((x) => x.id === a.id)!.data).toMatchObject({ deposit: 2000, goodsFund: 1000 });
    const none = listed.find((x) => x.id === b.id)!;
    expect(none.data.deposit).toBeUndefined();
    expect(none.data.goodsFund).toBeUndefined();
    // 修改最新快照后，店铺档案跟着变；档案里没有任何存库的资金值
    const latest = (await svc.list(boss, 'store-funds', { page: 1, pageSize: 50 })).items.find((x) => x.data.snapshotDate === '2026-03-09')!;
    await svc.update(boss, 'store-funds', latest.id, { deposit: 2500 });
    expect((await svc.get(boss, 'stores', a.id)).data.deposit).toBe(2500);
    const raw = await ds.manager.findOneByOrFail(ResourceRecord, { id: a.id, companyId: boss.companyId });
    expect(raw.data.deposit).toBeUndefined();
    expect(raw.data.goodsFund).toBeUndefined();
  });

  it('旧版本手填在店铺档案里的资金：补成“旧系统档案登记”快照并清掉手填值；已有快照的只清不补；再跑一次没有可补的', async () => {
    const s1 = await mkStore(boss, '回填店1');
    const s2 = await mkStore(boss, '回填店2');
    for (const [id, data] of [[s1.id, { deposit: 5000, goodsFund: 600, frozen: 70, promotionBalance: 8 }], [s2.id, { deposit: 9 }]] as const) {
      const r = await ds.manager.findOneByOrFail(ResourceRecord, { id, companyId: boss.companyId });
      r.data = { ...r.data, ...data };
      await ds.manager.save(r);
    }
    await svc.create(boss, 'store-funds', { storeId: s2.id, snapshotDate: '2026-05-01', deposit: 123 });
    const plan = await planStoreFundBackfill(ds.manager, boss.companyId);
    expect(plan.map((p) => p.storeId).sort()).toEqual([s1.id, s2.id].sort());
    expect(plan.find((p) => p.storeId === s2.id)!.date).toBe('');
    const done = await applyStoreFundBackfill(ds.manager, svc, boss, plan);
    expect(done).toEqual({ snapshots: 1, cleared: 2 });
    const g1 = await svc.get(boss, 'stores', s1.id);
    expect(g1.data).toMatchObject({ deposit: 5000, goodsFund: 600, frozen: 70, promotionBalance: 8 });
    const snaps = (await svc.list(boss, 'store-funds', { page: 1, pageSize: 50 })).items.filter((x) => x.data.storeId === s1.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].data).toMatchObject({ source: 'legacy', note: '旧系统档案登记', withdrawable: 600 });
    expect((await svc.get(boss, 'stores', s2.id)).data.deposit).toBe(123);
    expect(await planStoreFundBackfill(ds.manager, boss.companyId)).toEqual([]);
  });
});
