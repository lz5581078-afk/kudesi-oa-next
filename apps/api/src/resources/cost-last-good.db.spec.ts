import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FinanceCostSnapshot, ResourceRecord, User } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { CostService } from './cost.service';
import { registerCostSnapshots, beginCostBatch, finishCostBatch } from './cost-snapshot';
import { buildServices } from '../test-support';
const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('完整有效成本托底', () => {
  let ds: DataSource, cost: CostService, actor: AuthUser, bundle: ResourceRecord, base: ResourceRecord;
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true } as never).initialize();
    cost = new CostService(ds);
  });
  afterAll(async () => { await ds?.destroy(); });
  beforeEach(async () => {
    const company = await ds.manager.save(Company, { code: `cg${randomBytes(5).toString('hex')}`, name: '成本托底隔离测试', status: 'active' });
    const user = await ds.manager.save(User, { companyId: company.id, account: 'admin', name: '测试', passwordHash: 'x', status: 'active', isCompanyAdmin: true, mustChangePassword: false });
    actor = { id: user.id, name: user.name, companyId: company.id, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const save = (type: string, data: Record<string, unknown>, status = 'active') => ds.manager.save(ResourceRecord, { companyId: company.id, type, title: type, data, status, searchText: '' });
    base = await save('finance-base-codes', { origin: 'external_import', externalCost: 120.1234, weightG: 500, code: 'BASE' }, 'verified');
    bundle = await save('finance-bundles', { code: 'BUNDLE', name: '测试组合', manualFreight: 800, marginOverridePercent: 20 }, 'verified');
    await save('finance-bundle-lines', { bundleId: bundle.id, baseCodeId: base.id, role: 'main', qty: 2 });
  });
  const register = () => ds.transaction(em => registerCostSnapshots(em, actor.companyId, actor.id, [bundle.id], '测试完整登记', 'manual'));
  const change = async (record: ResourceRecord, data: Record<string, unknown>) => { record.data = data; await ds.manager.save(ResourceRecord, record); };
  it('运费丢失且成本变化时整套沿用历史，恢复后整套更新，详情和对外一致', async () => {
    const original = await cost.one(actor, bundle.id);
    expect(await register()).toMatchObject({ recorded: 1 });
    expect(await register()).toMatchObject({ recorded: 0, unchanged: 1 });
    await change(bundle, { ...bundle.data, manualFreight: null });
    await change(base, { ...base.data, externalCost: 300 });
    expect(await register()).toMatchObject({ recorded: 0, invalid: 1 });
    const row = await cost.one(actor, bundle.id);
    expect(row).toMatchObject({ costState: 'fallback', preShipCostCents: original.preShipCostCents, freightCents: 800, minPriceCents: original.minPriceCents, lines: original.lines });
    expect(row.issues.join()).toContain('运费'); expect(row.lastSuccessfulAt).toBeTruthy();
    expect((await cost.allRows(actor)).rows[0]).toEqual(row);
    expect((await cost.verifiedFeed(actor.companyId))[0]).toMatchObject({ minPriceCents: original.minPriceCents, freightCents: 800 });
    expect((await cost.liveAllRows(actor)).rows[0]).toMatchObject({ preShipCostCents: 600, freightCents: null, minPriceCents: null });
    await change(bundle, { ...bundle.data, manualFreight: 900 });
    expect(await register()).toMatchObject({ recorded: 1 });
    expect(await cost.one(actor, bundle.id)).toMatchObject({ costState: 'current', preShipCostCents: 600, freightCents: 900, minPriceCents: 1875, issues: [] });
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId })).toBe(2);
  });
  it('保存的运费预估失效时保留完整成本，利润率变化也不能与旧运费拼接', async () => {
    await change(bundle, { ...bundle.data, manualFreight: null });
    const snapshot = await ds.manager.save(ResourceRecord, { companyId: actor.companyId, type: 'finance-freight-estimates', uniqueKey: 'default', title: '预估', status: 'active', searchText: '', data: { parcelLimit: 30, rowsJson: JSON.stringify([{ start: 0, end: 2, method: 'provincial_majority_mean_plus_10_percent', autoAmount: 700 }]) } });
    const resources = buildServices(ds).resources;
    await ds.transaction(em => resources.patchData(em, actor, 'finance-freight-estimates', snapshot.id, { rowsJson: '[]' }));
    await ds.transaction(em => resources.patchData(em, actor, 'finance-bundles', bundle.id, { marginOverridePercent: 30 }));
    expect(await cost.one(actor, bundle.id)).toMatchObject({ costState: 'fallback', freightCents: 700, marginPercent: 20, pricingSettings: { ownPercent: 30 } });
    await ds.transaction(em => resources.patchData(em, actor, 'finance-freight-estimates', snapshot.id, { rowsJson: JSON.stringify([{ start: 0, end: 2, method: 'provincial_majority_mean_plus_10_percent', autoAmount: 900 }]) }));
    expect(await cost.one(actor, bundle.id)).toMatchObject({ costState: 'current', freightCents: 900, marginPercent: 30, issues: [] });
  });
  it('整组编辑只登记最终完整结果，不把中途尚未填完的组合当作兜底', async () => {
    await register();
    const original = await cost.one(actor, bundle.id);
    const resources = buildServices(ds).resources;
    await ds.transaction(async em => {
      await beginCostBatch(em, actor.companyId, actor.id, 'finance-bundles');
      await resources.patchData(em, actor, 'finance-bundles', bundle.id, { manualFreight: 1200 });
      await resources.patchData(em, actor, 'finance-bundles', bundle.id, { manualFreight: null });
      await finishCostBatch(em, actor.companyId, actor.id, 'finance-bundles');
    });
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId })).toBe(1);
    expect(await cost.one(actor, bundle.id)).toMatchObject({ costState: 'fallback', freightCents: original.freightCents, minPriceCents: original.minPriceCents });
  });
  it('没有有效历史时缺项保持未知，明确填写零运费则有效', async () => {
    await change(bundle, { ...bundle.data, manualFreight: null });
    expect(await cost.one(actor, bundle.id)).toMatchObject({ costState: 'incomplete', freightCents: null, minPriceCents: null });
    expect(await register()).toMatchObject({ invalid: 1, recorded: 0 });
    await change(bundle, { ...bundle.data, manualFreight: 0 });
    expect(await register()).toMatchObject({ recorded: 1 });
    expect(await cost.one(actor, bundle.id)).toMatchObject({ costState: 'current', freightCents: 0 });
  });
  it('旧历史的半套数据不能覆盖整套有效记录，不能跨公司或组合兜底', async () => {
    await register();
    await ds.manager.insert(FinanceCostSnapshot, { companyId: actor.companyId, bundleId: bundle.id, code: 'BUNDLE', name: '不完整历史', revision: 2, preShipCostCents: 9999, weightG: null, freightCents: null, marginPercent: null, minPriceCents: null, reason: '', eventType: 'manual' });
    await change(base, { ...base.data, externalCost: null, weightG: null });
    expect(await cost.one(actor, bundle.id)).toMatchObject({ costState: 'fallback', preShipCostCents: 240.2468, weightG: 1000 });
    const foreign = { ...actor, companyId: actor.companyId + 100000 };
    expect((await cost.allRows(foreign)).rows).toEqual([]);
    await ds.manager.update(FinanceCostSnapshot, { companyId: actor.companyId }, { bundleId: bundle.id + 100000 });
    expect(await cost.one(actor, bundle.id)).toMatchObject({ costState: 'incomplete', preShipCostCents: null, weightG: null });
  });
  it('真实维护入口自动保存更新前后完整结果，回滚不留下新版本', async () => {
    const resources = buildServices(ds).resources;
    await ds.transaction(em => resources.patchData(em, actor, 'finance-bundles', bundle.id, { manualFreight: 850 }));
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId })).toBe(2);
    await expect(ds.transaction(async em => { await resources.patchData(em, actor, 'finance-bundles', bundle.id, { manualFreight: 950 }); throw new Error('回滚'); })).rejects.toThrow('回滚');
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId })).toBe(2);
    await ds.transaction(em => resources.patchData(em, actor, 'finance-bundles', bundle.id, { manualFreight: null }));
    expect(await cost.one(actor, bundle.id)).toMatchObject({ costState: 'fallback', freightCents: 850 });
  });
});
