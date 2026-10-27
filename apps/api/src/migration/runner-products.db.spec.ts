/** 迁入：单位与规格列表、商品里存单位编码、六类成本记录、多构成基础编码（隔离MySQL） */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { runLegacyImport } from './runner';
import { LegacyArchive, legacyRef as ref } from './protocol';

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
});
