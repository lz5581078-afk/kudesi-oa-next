import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { FinanceDocumentsService } from './finance-documents.service';
import type { ResourcesService } from './resources.service';
const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('24号经营中心的店铺日报趋势（隔离数据库）', () => {
  let ds: DataSource, resources: ResourcesService, docs: FinanceDocumentsService, actor: AuthUser, other: AuthUser;
  const user = async (name: string): Promise<AuthUser> => {
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `ov${crypto.randomBytes(5).toString('hex')}`, name, status:'active' }));
    const row = await ds.manager.save(User, ds.manager.create(User, { companyId:company.id, account:'admin', passwordHash:'x', name, isCompanyAdmin:true, status:'active', mustChangePassword:false }));
    return { id:row.id, companyId:company.id, name, permissions:{ isCompanyAdmin:true, allow:[], deny:[] } };
  };
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME:process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun:true } as never); await ds.initialize();
    resources = buildServices(ds).resources; docs = new FinanceDocumentsService(ds);
    actor = await user('合成经营甲'), other = await user('合成经营乙');
    const store = async (u: AuthUser, name: string) => (await resources.create(u,'stores',{name,platform:'pdd'})).id;
    const a = await store(actor,'合成甲店'), b = await store(actor,'合成负利润店'), foreign = await store(other,'合成乙店');
    const metric = (u: AuthUser, storeId: number, day: string, values: Record<string,number>) => resources.create(u,'store-daily-metrics',{storeId,day,sales:0,refund:0,adCost:0,platformFee:0,purchaseCost:0,otherCost:0,...values});
    await metric(actor,a,'2026-01-01',{sales:10000,refund:500,adCost:1000,platformFee:200,purchaseCost:3000,otherCost:100});
    await metric(actor,b,'2026-01-01',{sales:2000,purchaseCost:3000});
    await metric(actor,a,'2026-01-02',{sales:500,purchaseCost:100});
    await metric(actor,a,'2026-02-01',{sales:100,purchaseCost:20});
    await metric(other,foreign,'2026-01-01',{sales:999999});
    const archived = await metric(actor,a,'2026-01-03',{sales:77777});
    await resources.remove(actor,'store-daily-metrics',archived.id,'合成归档日报');
  });
  afterAll(async () => { await ds?.destroy(); });
  it('趋势按真实日报逐日汇总，含退款等全部成本；与单据分录独立，日期和归档范围一致', async () => {
    const result = await docs.overview(actor,'2026-01');
    expect(result.trend).toEqual([]);
    expect(result.storeTrend).toEqual([
      { date:'2026-01-01',salesCents:12000,costCents:7800,profitCents:4200 },
      { date:'2026-01-02',salesCents:500,costCents:100,profitCents:400 },
    ]);
    expect(result.stores.find(row => row.name === '合成甲店')).toMatchObject({salesCents:10500,profitCents:5600,platformLabel:'拼多多'});
    expect(result.stores.find(row => row.name === '合成负利润店')).toMatchObject({salesCents:2000,profitCents:-1000});
    expect((await docs.overview(actor,'all')).storeTrend).toHaveLength(3);
    expect((await docs.overview(actor,undefined,'2026-01-02','2026-01-02')).storeTrend).toEqual([result.storeTrend[1]]);
  });
  it('成本/利润服务端脱敏、公司隔离；缺经营权限拒绝且空期间不补假零值', async () => {
    const viewer = { ...actor, permissions:{isCompanyAdmin:false,allow:['finance.overview.view'],deny:[]} };
    const result = await docs.overview(viewer,'all');
    expect(result.storeTrend).toHaveLength(3);
    expect(result.storeTrend.every(row => row.costCents === null && row.profitCents === null)).toBe(true);
    expect(result.stores.every(row => row.profitCents === null)).toBe(true);
    expect((await docs.overview(other,'all')).storeTrend).toEqual([{date:'2026-01-01',salesCents:999999,costCents:0,profitCents:999999}]);
    expect((await docs.overview(actor,'2027-01')).storeTrend).toEqual([]);
    await expect(docs.overview({...viewer,permissions:{...viewer.permissions,allow:[]}},'all')).rejects.toThrow(/权限/);
  });
});
