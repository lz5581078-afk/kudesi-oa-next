/** 验证快照事实与成本/重量分别匹配；隔离合成资料。 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FinanceCostSnapshot, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { CostService } from './cost.service';
import { ResourcesService } from './resources.service';
import { DataToolsService } from './data-tools.service';
import { BundleToolsService } from './bundle-tools.service';
import { OutboxService } from '../outbox/outbox.service';
import { baseCodeOutbound, buildSnapshot, diffSnapshots } from './base-code-support';
import { bundleSnapshotJson } from './finance-rules';
const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('成本组成验证快照（真实数据库）', () => {
  let ds: DataSource, svc: ResourcesService, cost: CostService, actor: AuthUser;
  let categoryId: number, bundleCategoryId: number, platformId: number, scenarioId: number;
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never).initialize();
    svc = buildServices(ds).resources; cost = new CostService(ds);
  });
  beforeEach(async () => {
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `snap${randomBytes(5).toString('hex')}`, name: '明细快照测试', status: 'active' }));
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '合成管理员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    actor = { id: user.id, companyId: company.id, name: user.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    categoryId = (await svc.create(actor, 'finance-categories', { archiveType: 'raw', name: '快照原料', code: 'KZYL' })).id;
    bundleCategoryId = (await svc.create(actor, 'finance-categories', { archiveType: 'bundle', name: '快照组合', code: 'KZZH' })).id;
    platformId = (await svc.create(actor, 'finance-platforms', { name: '快照平台', code: 'KZPT' })).id;
    scenarioId = (await svc.create(actor, 'finance-scenarios', { name: '标准', code: 'standard' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });
  async function fixture(verify = true) {
    const product = await svc.create(actor, 'finance-products', { archiveType: 'raw', name: `合成快照原料${randomBytes(3).toString('hex')}`, categoryId, specQty: 1, specUnit: 'KG', purchaseSpec: '斤', purchasePrice: 100, freight: 1, handlingFee: 1 });
    const base = (await svc.list(actor, 'finance-base-codes', { fieldKey: 'productId', fieldValue: String(product.id) })).items[0];
    await svc.changeStatus(actor, 'finance-base-codes', base.id, 'verified');
    const bundle = await svc.create(actor, 'finance-bundles', { platformId, scenarioId, bundleCategoryId });
    await svc.create(actor, 'finance-bundle-lines', { bundleId: bundle.id, role: 'main', baseCodeId: base.id, qty: 1 });
    const verified = verify ? await svc.changeStatus(actor, 'finance-bundles', bundle.id, 'verified') : await svc.get(actor, 'finance-bundles', bundle.id);
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
  it('基础编码人工重量用于组合、验证快照和上传；来源重量变化仍保留专属修正', async () => {
    const { product, base, bundle } = await fixture(false);
    await svc.confirmBaseProfile(actor, 'finance-base-codes', base.id, { weightG: 750.123456 });
    if ((await svc.get(actor, 'finance-base-codes', base.id)).status !== 'verified') await svc.changeStatus(actor, 'finance-base-codes', base.id, 'verified');
    await svc.changeStatus(actor, 'finance-bundles', bundle.id, 'verified');
    let row = await cost.one(actor, bundle.id);
    expect(row.weightG).toBe(750.123456);
    expect(row.lines[0].unitWeightG).toBe(750.123456);
    let record = await ds.manager.findOneByOrFail(ResourceRecord, { id: base.id });
    expect((await baseCodeOutbound(ds.manager, actor.companyId, record)).weight).toBe(0.750123);
    const lines = (await svc.list(actor, 'finance-bundle-lines', { fieldKey: 'bundleId', fieldValue: String(bundle.id) })).items.map(line => line.data);
    const snap = JSON.parse(await bundleSnapshotJson(ds.manager, actor.companyId, bundle.data, lines));
    expect(snap).toMatchObject({ lines: [{ weightG: 750.123456 }], breakdown: { weightG: 750.123456, lines: [{ unitWeightG: 750.123456 }] } });
    await svc.update(actor, 'finance-products', product.id, { purchaseSpec: '千克', purchasePrice: 130 });
    row = await cost.one(actor, bundle.id);
    expect(row).toMatchObject({ weightG: 750.123456, preShipCostCents: 132 });
    record = await ds.manager.findOneByOrFail(ResourceRecord, { id: base.id });
    expect(await baseCodeOutbound(ds.manager, actor.companyId, record)).toMatchObject({ weight: 0.750123, cost_price: 1.32 });
  });

  it('马甲保留名称编码，但组合和上传读取真实编码人工重量，不读取马甲自己的修正', async () => {
    const { product, base, bundle } = await fixture(false);
    await svc.confirmBaseProfile(actor, 'finance-base-codes', base.id, { weightG: 825 });
    await svc.update(actor, 'finance-products', product.id, { rawFinishedNames: '合成别名' });
    const alias = (await ds.manager.find(ResourceRecord, { where: { companyId: actor.companyId, type: 'finance-base-codes' } })).find(row => row.data.canonicalId === base.id)!;
    expect(alias).toBeTruthy();
    // 模拟旧资料里马甲独立保存过另一个重量；真实编码仍是取值依据。
    await ds.manager.save(ResourceRecord, { ...alias, data: { ...alias.data, profileWeightOverride: 999, weightG: 999 } });
    const line = (await svc.list(actor, 'finance-bundle-lines', { fieldKey: 'bundleId', fieldValue: String(bundle.id) })).items[0];
    // 换基础编码的正常入口要求已验证；本例只合成历史引用，验证成本解析。
    const saved = await ds.manager.findOneByOrFail(ResourceRecord, { id: line.id });
    await ds.manager.save(ResourceRecord, { ...saved, data: { ...saved.data, baseCodeId: alias.id } });
    for (const id of [base.id, alias.id]) if ((await svc.get(actor, 'finance-base-codes', id)).status !== 'verified') await svc.changeStatus(actor, 'finance-base-codes', id, 'verified');
    await svc.changeStatus(actor, 'finance-bundles', bundle.id, 'verified');
    const row = await cost.one(actor, bundle.id);
    expect(row).toMatchObject({ weightG: 825, preShipCostCents: 102, lines: [{ code: alias.data.code, name: alias.data.name, unitWeightG: 825 }] });
    expect(await baseCodeOutbound(ds.manager, actor.companyId, alias)).toMatchObject({ sku_id: alias.data.code, name: alias.data.name, weight: 0.825, cost_price: 1.02 });
    const snap = JSON.parse(await bundleSnapshotJson(ds.manager, actor.companyId, bundle.data, [{ ...line.data, baseCodeId: alias.id }]));
    expect(snap).toMatchObject({ lines: [{ ref: alias.data.code, weightG: 825 }], breakdown: { weightG: 825, lines: [{ code: alias.data.code, unitWeightG: 825 }] } });
  });

  it('多构成基础编码仍按组成算成本，独立人工重量用于组合与上传', async () => {
    const { product, bundle } = await fixture(false);
    const composed = await svc.create(actor, 'finance-base-codes', { origin: 'composed', productId: product.id, codeCategoryId: categoryId, codeSpecQty: 2, codeSpecUnit: 'KG', name: '合成组合基础品', shortName: '合成基础品', varietyName: '合成品种' });
    await svc.confirmBaseProfile(actor, 'finance-base-codes', composed.id, { weightG: 410.25 });
    await svc.changeStatus(actor, 'finance-base-codes', composed.id, 'verified');
    const line = (await svc.list(actor, 'finance-bundle-lines', { fieldKey: 'bundleId', fieldValue: String(bundle.id) })).items[0];
    await svc.update(actor, 'finance-bundle-lines', line.id, { baseCodeId: composed.id, qty: 2 });
    await svc.changeStatus(actor, 'finance-bundles', bundle.id, 'verified');
    expect(await cost.one(actor, bundle.id)).toMatchObject({ preShipCostCents: 204, weightG: 820.5, lines: [{ unitCostCents: 102, unitWeightG: 410.25 }] });
    const saved = await ds.manager.findOneByOrFail(ResourceRecord, { id: composed.id });
    expect(await baseCodeOutbound(ds.manager, actor.companyId, saved)).toMatchObject({ weight: 0.41025, cost_price: 1.02 });
  });

  it('真实编码专属资料改变后，马甲指纹及二次验证差异同步更新', async () => {
    const { product, base } = await fixture(false);
    await svc.update(actor, 'finance-products', product.id, { rawFinishedNames: '合成验证别名' });
    const alias = (await ds.manager.find(ResourceRecord, { where: { companyId: actor.companyId, type: 'finance-base-codes' } })).find(row => row.data.canonicalId === base.id)!;
    for (const id of [base.id, alias.id]) if ((await svc.get(actor, 'finance-base-codes', id)).status !== 'verified') await svc.changeStatus(actor, 'finance-base-codes', id, 'verified');
    const saved = await ds.manager.findOneByOrFail(ResourceRecord, { id: alias.id });
    const before = await buildSnapshot(ds.manager, actor.companyId, saved);
    await svc.confirmBaseProfile(actor, 'finance-base-codes', base.id, { weightG: 765.5 });
    expect((await svc.get(actor, 'finance-base-codes', alias.id)).status).toBe('reverify');
    const after = await buildSnapshot(ds.manager, actor.companyId, saved);
    expect(after.signature).not.toBe(before.signature);
    expect(after.snapshot.canonical).toMatchObject({ profileWeightG: 765.5 });
    expect(diffSnapshots(before.snapshot, after.snapshot)).toEqual(expect.arrayContaining([expect.objectContaining({ source: '真实基础编码', field: 'profileWeightG', after: 765.5 })]));
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

  async function removeCurrentValues(productId: number) {
    const record = await ds.manager.findOneByOrFail(ResourceRecord, { id: productId });
    const data = { ...record.data }; delete data.weightG; delete data.totalCost;
    await ds.manager.save(ResourceRecord, { ...record, data });
  }

  async function fill(tools: DataToolsService, bundleId?: number) {
    const preview = await tools.previewCostRegistration(actor);
    return tools.registerCost(actor, bundleId, '补齐', undefined, 'workflow_publish', true, { confirmed: true, signature: preview.signature });
  }

  it('当前来源缺项时表格保留上次登记值，验证报告仍保留未知；不登记虚假的空值变化', async () => {
    const { product, bundle } = await fixture();
    const tools = new DataToolsService(ds, cost);
    await tools.registerCost(actor, bundle.id, '原有效登记');
    const count = await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId });
    await removeCurrentValues(product.id);
    const live = await cost.one(actor, bundle.id);
    expect(live.preShipCostCents).toBeNull(); expect(live.weightG).toBeNull();
    const row = (await cost.allRows(actor)).rows.find(row => row.bundleId === bundle.id)!;
    expect(row).toMatchObject({ preShipCostCents: 102, weightG: 500 });
    expect(row.breakdown?.cost).toMatchObject({ source: '验证快照', total: 102, matches: true });
    expect(await tools.registerCost(actor, bundle.id, '来源缺项', undefined, 'source_values_update')).toMatchObject({ recorded: 0, unchanged: 1 });
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId })).toBe(count);
  });

  it('金额和重量分别找最后的有效登记，旧历史的空值不覆盖有效值', async () => {
    const { product, bundle } = await fixture();
    const history = (revision: number, preShipCostCents: number | null, weightG: number | null) => ds.manager.save(FinanceCostSnapshot, ds.manager.create(FinanceCostSnapshot, {
      companyId: actor.companyId, bundleId: bundle.id, code: String(bundle.data.code), name: bundle.title, revision, preShipCostCents, weightG,
      freightCents: null, marginPercent: null, minPriceCents: null, reason: '合成历史兼容', eventType: 'manual', actorId: actor.id,
    }));
    await history(1, 200, null); await history(2, null, 1500);
    await removeCurrentValues(product.id);
    const row = (await cost.allRows(actor)).rows[0];
    expect(row).toMatchObject({ preShipCostCents: 200, weightG: 1500 });
    expect(row.breakdown?.cost).toMatchObject({ total: 200, componentTotal: 102, difference: 98, matches: false });
    expect(row.breakdown?.weight).toMatchObject({ total: 1500, componentTotal: 500, difference: 1000, matches: false });
  });

  it('尚无历史行时可用验证发布值作基线，但补齐操作不能替当前缺项资料登记', async () => {
    const { product, bundle } = await fixture();
    await removeCurrentValues(product.id);
    expect((await cost.allRows(actor)).rows[0]).toMatchObject({ preShipCostCents: 102, weightG: 500 });
    const tools = new DataToolsService(ds, cost);
    const preview = await tools.previewCostRegistration(actor);
    expect(preview.rows).toHaveLength(0); expect(preview.issues).toHaveLength(1);
    expect(await fill(tools)).toMatchObject({ recorded: 0 });
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId })).toBe(0);
  });

  it('补齐只处理未登记的已验证SKU，不重写已有记录、不登记待验证资料，重复调用无新增', async () => {
    const a = await fixture(), pending = await fixture(false), b = await fixture();
    const tools = new DataToolsService(ds, cost);
    await tools.registerCost(actor, a.bundle.id, '已有登记');
    expect(await fill(tools)).toMatchObject({ recorded: 1 });
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId, bundleId: pending.bundle.id })).toBe(0);
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId, bundleId: b.bundle.id })).toBe(1);
    expect((await ds.manager.findOneByOrFail(FinanceCostSnapshot, { companyId: actor.companyId, bundleId: a.bundle.id })).reason).toBe('已有登记');
    expect(await fill(tools)).toMatchObject({ recorded: 0 });
    await expect(fill(tools, pending.bundle.id)).rejects.toThrow(/已经验证/);
  });

  it('批量登记第二条失败时第一条也回滚，重试后每个SKU只登记一次', async () => {
    await fixture(); await fixture();
    const original = EntityManager.prototype.insert;
    let count = 0;
    const fail = jest.spyOn(EntityManager.prototype, 'insert').mockImplementation(async function(this: EntityManager, target: any, value: any) {
      if (target === FinanceCostSnapshot && ++count === 2) throw new Error('模拟第二条登记失败');
      return original.call(this, target, value);
    });
    const tools = new DataToolsService(ds, cost);
    try { await expect(fill(tools)).rejects.toThrow(/第二条/); }
    finally { fail.mockRestore(); }
    expect(count).toBe(2);
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId })).toBe(0);
    expect(await fill(tools)).toMatchObject({ recorded: 2 });
  });

  it('补齐需要明确确认；预览后来源发生变化必须重新核对', async () => {
    const { product } = await fixture();
    const tools = new DataToolsService(ds, cost);
    const preview = await tools.previewCostRegistration(actor);
    await expect(tools.registerCost(actor, undefined, '补齐', undefined, 'workflow_publish', true)).rejects.toThrow(/预览并确认/);
    await svc.update(actor, 'finance-products', product.id, { purchasePrice: 130 });
    // 来源变更可能自动登记历史；只核对补齐本身没有另写一条。
    const before = await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId });
    await expect(tools.registerCost(actor, undefined, '补齐', undefined, 'workflow_publish', true, { confirmed: true, signature: preview.signature })).rejects.toThrow(/重新预览/);
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId })).toBe(before);
  });

  it('预览把不完整资料留在需核对清单，只补齐有效项', async () => {
    const good = await fixture(), bad = await fixture();
    await removeCurrentValues(bad.product.id);
    const tools = new DataToolsService(ds, cost);
    const preview = await tools.previewCostRegistration(actor);
    expect(preview.rows.map(row => row.id)).toEqual([good.bundle.id]);
    expect(preview.issues).toMatchObject([{ id: bad.bundle.id, issues: expect.arrayContaining(['缺少有效总成本', '缺少有效重量']) }]);
    expect(await fill(tools)).toMatchObject({ recorded: 1 });
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId, bundleId: bad.bundle.id })).toBe(0);
  });

  it('同一预览并发确认只登记一次，后一个请求要求重新预览', async () => {
    const { bundle } = await fixture();
    const tools = new DataToolsService(ds, cost);
    const preview = await tools.previewCostRegistration(actor);
    const results = await Promise.allSettled([1, 2].map(() => tools.registerCost(actor, undefined, '补齐', undefined, 'workflow_publish', true, { confirmed: true, signature: preview.signature })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(String(failure.reason)).toMatch(/重新预览/);
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId, bundleId: bundle.id })).toBe(1);
  });

  it('成本重量完整但历史分类已非末级时也要留待核对', async () => {
    const { bundle } = await fixture();
    // 模拟历史资料绕过了现有编辑守卫：不是给真实业务写测试记录。
    const child = await svc.create(actor, 'finance-categories', { archiveType: 'bundle', name: '合成下级', code: 'KZXJ' });
    const record = await ds.manager.findOneByOrFail(ResourceRecord, { id: child.id });
    await ds.manager.save(ResourceRecord, { ...record, data: { ...record.data, parentId: bundleCategoryId } });
    const tools = new DataToolsService(ds, cost);
    const preview = await tools.previewCostRegistration(actor);
    expect(preview.rows).toEqual([]);
    expect(preview.issues).toMatchObject([{ id: bundle.id, issues: expect.arrayContaining(['组合分类必须选最末级']) }]);
    expect(await fill(tools)).toMatchObject({ recorded: 0 });
  });

  it('验证发布与成本登记同一事务，登记失败不能留下已验证状态', async () => {
    const { bundle } = await fixture(false);
    const tools = new BundleToolsService(ds, svc, new OutboxService(ds, svc));
    const report = await tools.report(actor, bundle.id);
    expect(report.issues).toEqual([]);
    const original = EntityManager.prototype.insert;
    const fail = jest.spyOn(EntityManager.prototype, 'insert').mockImplementation(async function(this: EntityManager, target: any, value: any) {
      if (target === FinanceCostSnapshot) throw new Error('模拟登记失败');
      return original.call(this, target, value);
    });
    try {
      const result = await tools.verify(actor, [{ id: bundle.id, signature: report.signature }], { confirmed: true, syncToJst: false });
      expect(result.verified).toBe(0);
      expect((await svc.get(actor, 'finance-bundles', bundle.id)).status).toBe('pending');
    } finally { fail.mockRestore(); }
    const result = await tools.verify(actor, [{ id: bundle.id, signature: report.signature }], { confirmed: true, syncToJst: false });
    expect(result.verified).toBe(1);
    expect(await ds.manager.countBy(FinanceCostSnapshot, { companyId: actor.companyId, bundleId: bundle.id })).toBe(1);
  });
});
