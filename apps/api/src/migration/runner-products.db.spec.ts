/** 迁入：单位与规格列表、商品里存单位编码、六类成本记录、多构成基础编码（隔离MySQL） */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { runLegacyImport } from './runner';
import { LegacyArchive, legacyRef as ref } from './protocol';
import { readSourceRow } from './source-rows';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('迁入商品档案新字段（隔离MySQL）', () => {
  let ds: DataSource, company: Company, actor: User, svc: ReturnType<typeof buildServices>, source: LegacyArchive;
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true }).initialize();
    svc = buildServices(ds);
    const tag = randomBytes(6).toString('hex');
    company = await ds.manager.save(Company, ds.manager.create(Company, { code: tag, name: '迁前公司', status: 'active' }));
    actor = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'mig-' + tag, name: '管理员', passwordHash: 'x', status: 'active', isCompanyAdmin: true, mustChangePassword: false }));
    source = {
      company: { id: 99, name: '迁入测试公司' }, departments: [], positions: [], employees: [], employeePositions: [], positionPermissions: [], exclusions: [], loadFile: async () => Buffer.from([1]),
      records: [
        { type: 'finance-product-units', id: 'spec_unit:1', data: { kind: 'spec_unit', name: '桶', code: 'TONG', sortOrder: 1 } },
        { type: 'finance-product-units', id: 'spec_unit:2', data: { kind: 'spec_unit', name: '千克', code: 'KG', sortOrder: 2 } },
        { type: 'finance-product-units', id: 'packaging_unit:1', data: { kind: 'packaging_unit', name: '袋', code: 'D', sortOrder: 1 } },
        { type: 'finance-categories', id: 'cat', data: { archiveType: 'raw', name: '来源原料分类', code: 'YL' } },
        { type: 'finance-products', id: 'p1', data: { archiveType: 'raw', name: '桶装油', code: 'LEGACY-OIL', categoryId: ref('finance-categories', 'cat'), specQty: 2, specUnit: 'TONG', purchaseSpec: '桶', purchasePrice: 100, freight: 100, handlingFee: 100, giftShortName: '油', giftCodeShortName: 'YOU', materialCode: 'SC9', weightG: 5000, weightManual: true } },
        { type: 'finance-products', id: 'p2', data: { archiveType: 'raw', name: '辅料', code: 'LEGACY-AUX', categoryId: ref('finance-categories', 'cat'), specQty: 1, specUnit: 'KG', purchaseSpec: '千克', purchasePrice: 100, freight: 100, handlingFee: 100 } },
        { type: 'finance-product-costs', id: 'c1', data: { productId: ref('finance-products', 'p1'), costType: 'transfer', unitCost: 12.34, unitName: '桶', effectiveFrom: '2026-01-01', sourceType: 'seasonal_cost_table' } },
        { type: 'finance-product-costs', id: 'c2', data: { productId: ref('finance-products', 'p1'), costType: 'express', unitCost: 5, unitName: '桶', effectiveFrom: '2026-01-01', manualOverride: true, manualLockReason: '手工价' } },
        { type: 'finance-base-codes', id: 'bc', data: { origin: 'composed', productId: ref('finance-products', 'p1'), codeCategoryId: ref('finance-categories', 'cat'), codeSpecQty: 1, codeSpecUnit: 'KG', code: 'LEGACY-BOX', name: '礼盒', shortName: '礼盒', varietyName: '礼盒', codeChangeReason: '迁移保留旧码' }, status: 'pending' },
        { type: 'finance-base-code-lines', id: 'bc:1', data: { baseCodeId: ref('finance-base-codes', 'bc'), productId: ref('finance-products', 'p1'), qty: 2, role: 'main' } },
        { type: 'finance-base-code-lines', id: 'bc:2', data: { baseCodeId: ref('finance-base-codes', 'bc'), productId: ref('finance-products', 'p2'), qty: 1, role: 'auxiliary' } },
      ],
    } as unknown as LegacyArchive;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('单位列表先进来，商品里的单位编码通过校验；成本记录和多构成行一并迁入', async () => {
    const result = await runLegacyImport(ds, svc.resources, svc.files, source, { companyId: company.id, actorId: actor.id, expectedName: '迁前公司', apply: true });
    expect(result.failures).toEqual([]);
    const all = (type: string) => ds.manager.find(ResourceRecord, { where: { companyId: company.id, type } });
    expect((await all('finance-product-units')).map((r) => r.data.code).sort()).toEqual(['D', 'KG', 'TONG']);
    const oil = (await all('finance-products')).find((r) => r.data.name === '桶装油')!;
    expect(oil.data).toMatchObject({ specUnit: 'TONG', giftShortName: '油', giftCodeShortName: 'YOU', materialCode: 'SC9' });
    expect(String(oil.data.basicInfoFullName)).toContain('桶'); // 全称显示单位名称，不是编码
    const costs = await all('finance-product-costs');
    expect(costs.map((c) => c.data.costType).sort()).toEqual(['express', 'transfer']);
    expect(costs.find((c) => c.data.costType === 'express')!.data).toMatchObject({ manualOverride: true, manualLockReason: '手工价' });
    const box = (await all('finance-base-codes')).find((r) => r.data.origin === 'composed')!;
    const lines = (await all('finance-base-code-lines')).filter((l) => l.data.baseCodeId === box.id);
    expect(lines.map((l) => l.data.qty).sort()).toEqual([1, 2]);
    // 重跑不重复
    const again = await runLegacyImport(ds, svc.resources, svc.files, source, { companyId: company.id, actorId: actor.id, expectedName: '迁前公司', apply: true });
    expect(again.failures).toEqual([]);
    expect(again.created).toEqual({});
  });
  it('专门历史模式保留重叠日期与系统来源、原精度及加密来源，普通新增仍受校验限制', async () => {
    const raw = (id: string, price: string) => ({ id, company_id: 99, product_id: 'p1', cost_type: 'purchase', unit_cost: price, effective_from: '2026-05-01', effective_to: null, source_type: 'archive_purchase_price', status: 'active' });
    const extra = [
      { type: 'finance-product-costs', id: '10001', status: 'active', sourceCostRow: raw('10001', '1.234567'), data: { productId: ref('finance-products', 'p1'), costType: 'purchase', unitCost: 123.4567, effectiveFrom: '2026-05-01', sourceType: 'archive_purchase_price' } },
      { type: 'finance-product-costs', id: '10002', status: 'active', sourceCostRow: raw('10002', '2.234567'), data: { productId: ref('finance-products', 'p1'), costType: 'purchase', unitCost: 223.4567, effectiveFrom: '2026-05-01', sourceType: 'archive_purchase_price' } },
    ];
    const next = { ...source, records: [...source.records, ...extra] };
    const opts = { companyId: company.id, actorId: actor.id, expectedName: '迁前公司', preserveCostHistory: true, sourceRowsCrypto: svc.crypto };
    const dry = await runLegacyImport(ds, svc.resources, svc.files, next, { ...opts, apply: false });
    expect(dry.failures).toEqual([]);
    expect(await readSourceRow(ds.manager, svc.crypto, { companyId: company.id, sourceCompanyId: 99, table: 'finance_product_archive_costs', key: '10001' })).toBeNull();
    const result = await runLegacyImport(ds, svc.resources, svc.files, next, { ...opts, apply: true, expectedReport: dry });
    expect(result.failures).toEqual([]);
    const id = result.mappings.find(r => r.type === 'finance-products' && r.sourceId === 'p1')?.targetId ?? (await ds.query("SELECT target_id FROM legacy_import_links WHERE company_id=? AND source_key='finance-products:p1'", [company.id]))[0].target_id;
    const stored = await ds.manager.find(ResourceRecord, { where: { companyId: company.id, type: 'finance-product-costs', status: 'active' } });
    expect(stored.filter(r => r.data.sourceType === 'archive_purchase_price').map(r => r.data.unitCost).sort()).toEqual([123.4567, 223.4567]);
    expect(stored.filter(r => r.data.sourceType === 'archive_purchase_price').every(r => r.data.effectiveFrom === '2026-05-01' && !r.data.effectiveTo)).toBe(true);
    expect(await readSourceRow(ds.manager, svc.crypto, { companyId: company.id, sourceCompanyId: 99, table: 'finance_product_archive_costs', key: '10001' })).toEqual(raw('10001', '1.234567'));
    expect((await ds.manager.findOneByOrFail(ResourceRecord, { id, companyId: company.id })).data.latestUnitCost).toBe(223.4567);
    const actorUser = { id: actor.id, companyId: company.id, name: actor.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const data = { productId: id, costType: 'purchase', unitCost: 333, effectiveFrom: '2026-05-01', sourceType: 'manual' };
    await expect(svc.resources.create(actorUser, 'finance-product-costs', data)).rejects.toThrow('重叠');
    await expect(svc.resources.create(actorUser, 'finance-product-costs', { ...data, sourceType: 'archive_purchase_price' })).rejects.toThrow('系统自动');
    const missing = { ...next, records: [...next.records, { ...extra[0], id: 'missing', sourceCostRow: undefined }] };
    const blocked = await runLegacyImport(ds, svc.resources, svc.files, missing, { ...opts, apply: false });
    expect(blocked.failures.some(r => r.id === 'missing' && r.reason.includes('原始行'))).toBe(true);
  });
  it('先保留全部旧费用编号；无编号费用随后自动编码，不抢占或重编旧码', async () => {
    const records = [
      { type: 'finance-fee-items', id: 'fee-blank', data: { name: '旧无编号费用', direction: 'expense' } },
      { type: 'finance-fee-items', id: 'fee-explicit', data: { name: '旧有编号费用', code: 'FY-001', direction: 'expense', categoryId: ref('finance-fee-categories', 'late-category') } },
      { type: 'finance-fee-categories', id: 'late-category', data: { name: '后置来源费用类别' } },
    ];
    const archive = { ...source, records };
    const opts = { companyId: company.id, actorId: actor.id, expectedName: '迁前公司' };
    const dry = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: false }); expect(dry.failures).toEqual([]);
    const applied = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: true, expectedReport: dry }); expect(applied.failures).toEqual([]);
    const fees = await ds.manager.find(ResourceRecord, { where: { companyId: company.id, type: 'finance-fee-items' } });
    expect(fees.find(r => r.title === '旧有编号费用')?.data.code).toBe('FY-001');
    expect(fees.find(r => r.title === '旧无编号费用')?.data.code).toBe('FY-002');
  });

});
