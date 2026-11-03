/** 验证快照事实与成本/重量分别匹配；隔离合成资料。 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { CostService } from './cost.service';
import { ResourcesService } from './resources.service';
const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('成本组成验证快照（真实数据库）', () => {
  let ds: DataSource, svc: ResourcesService, cost: CostService, actor: AuthUser;
  let categoryId: number, bundleCategoryId: number, platformId: number, scenarioId: number;
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never).initialize();
    svc = buildServices(ds).resources; cost = new CostService(ds);
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `snap${randomBytes(5).toString('hex')}`, name: '明细快照测试', status: 'active' }));
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '合成管理员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    actor = { id: user.id, companyId: company.id, name: user.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    categoryId = (await svc.create(actor, 'finance-categories', { archiveType: 'raw', name: '快照原料', code: 'KZYL' })).id;
    bundleCategoryId = (await svc.create(actor, 'finance-categories', { archiveType: 'bundle', name: '快照组合', code: 'KZZH' })).id;
    platformId = (await svc.create(actor, 'finance-platforms', { name: '快照平台', code: 'KZPT' })).id;
    scenarioId = (await svc.create(actor, 'finance-scenarios', { name: '标准', code: 'standard' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });
  async function fixture() {
    const product = await svc.create(actor, 'finance-products', { archiveType: 'raw', name: `合成快照原料${randomBytes(3).toString('hex')}`, categoryId, specQty: 1, specUnit: 'KG', purchaseSpec: '斤', purchasePrice: 100, freight: 1, handlingFee: 1 });
    const base = (await svc.list(actor, 'finance-base-codes', { fieldKey: 'productId', fieldValue: String(product.id) })).items[0];
    await svc.changeStatus(actor, 'finance-base-codes', base.id, 'verified');
    const bundle = await svc.create(actor, 'finance-bundles', { platformId, scenarioId, bundleCategoryId });
    await svc.create(actor, 'finance-bundle-lines', { bundleId: bundle.id, role: 'main', baseCodeId: base.id, qty: 1 });
    const verified = await svc.changeStatus(actor, 'finance-bundles', bundle.id, 'verified');
    return { product, base, bundle: verified };
  }
  it('验证时保存实际名称和系统规格，金额一致而重量更新时分别选择来源', async () => {
    const { product, base, bundle } = await fixture();
    const snapshot = JSON.parse(String(bundle.data.snapshot));
    expect(snapshot.breakdown).toMatchObject({ preShipCostCents: 102, weightG: 500, lines: [{ name: String(base.data.name), unitName: '斤', unitCostCents: 102, weightG: 500 }] });
    await svc.update(actor, 'finance-products', product.id, { name: '后来修改名称', purchaseSpec: '千克' });
    const row = await cost.one(actor, bundle.id);
    expect(row.breakdown?.cost).toMatchObject({ source: '验证快照', matches: true, lines: [{ name: String(base.data.name), unitName: '斤' }] });
    expect(row.breakdown?.weight).toMatchObject({ source: '当前组成', total: 1000, matches: true, lines: [{ unitName: '千克' }] });
    await svc.update(actor, 'finance-products', product.id, { purchasePrice: 120 });
    const changed = await cost.one(actor, bundle.id);
    expect(changed.breakdown?.cost).toMatchObject({ source: '当前组成', total: 122, matches: true });
    const withoutCost = await svc.get({ ...actor, permissions: { isCompanyAdmin: false, allow: ['resource.finance-bundles.view'], deny: [] } }, 'finance-bundles', bundle.id);
    expect(withoutCost.data.snapshot).toBeUndefined();
  });
  it('旧版新版数字快照没有保存名称或计价单位时保持未知，不填入后来资料', async () => {
    const { bundle } = await fixture();
    const record = await ds.manager.findOneByOrFail(ResourceRecord, { id: bundle.id });
    const saved = JSON.parse(String(record.data.snapshot)); delete saved.breakdown;
    await ds.manager.save(ResourceRecord, { ...record, data: { ...record.data, snapshot: JSON.stringify(saved) } });
    const row = await cost.one(actor, bundle.id);
    expect(row.breakdown?.cost.source).toBe('验证快照');
    expect(row.breakdown?.cost.lines[0].name).toBe(saved.lines[0].ref);
    expect(row.breakdown?.cost.lines[0].unitName).toBeUndefined();
  });
  it('部分组成缺少重量时当前合计保持未知，不把缺失资料按0拼入有效重量', async () => {
    const { product, bundle } = await fixture();
    const record = await ds.manager.findOneByOrFail(ResourceRecord, { id: product.id });
    const data = { ...record.data }; delete data.weightG;
    await ds.manager.save(ResourceRecord, { ...record, data });
    const row = await cost.one(actor, bundle.id);
    expect(row.weightG).toBeNull();
    expect(row.lines[0].weightG).toBeNull();
    expect(row.lines[0].unitWeightG).toBeNull();
  });
});
