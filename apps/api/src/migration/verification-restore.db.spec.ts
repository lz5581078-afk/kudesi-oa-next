import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import type { AuthUser } from '../common/auth.decorators';
import type { LegacyArchive } from './protocol';
import { restoreBaseVerifications, restoreBundleVerifications } from './verification-restore';
import { buildSnapshot } from '../resources/base-code-support';

const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('迁入验证原决定与转换后值的核对（MySQL）', () => {
  let ds: DataSource, svc: ReturnType<typeof buildServices>, admin: AuthUser, categoryId: number;
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true }).initialize();
    svc = buildServices(ds);
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: randomBytes(6).toString('hex'), name: '验证迁入', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: randomBytes(6).toString('hex'), name: '原验证人', passwordHash: 'x', status: 'active', isCompanyAdmin: true, mustChangePassword: false }));
    admin = { id: u.id, companyId: company.id, name: u.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    categoryId = (await svc.resources.create(admin, 'finance-categories', { archiveType: 'raw', name: '测试分类', code: 'CS' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });
  async function fixture() {
    const productId = (await svc.resources.create(admin, 'finance-products', { archiveType: 'raw', name: `原商品${randomBytes(3).toString('hex')}`, categoryId, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 100, handlingFee: 50 })).id;
    const bc = (await svc.resources.findWhere(ds.manager, admin.companyId, 'finance-base-codes', 'productId', productId))[0];
    const at = '2026-06-15 12:34:56';
    const row = { company_id: 3, id: '80', kind: 'base', report: { status: 'verified', signature: 'a'.repeat(64), issues: [], verifiedAt: at, snapshot: { profile: { final_code: bc.data.code, product_name: bc.data.name, weighing_weight: Number(bc.data.weightG) / 1000, cost_price: Number(bc.data.cost) / 100 }, archives: { '50': {} } } } };
    const source: LegacyArchive = { company: { id: 3, name: '验证迁入' }, departments: [], positions: [], employees: [], employeePositions: [], positionPermissions: [], records: [], exclusions: [], loadFile: async () => Buffer.alloc(0), sourceRows: [{ table: 'legacy_verification_reports', key: 'base:80', row }, { table: 'finance_product_data_verifications', key: '[3,80]', row: { company_id: 3, base_code_id: 80, verified_by: 20, verified_at: at, composition_signature: 'a'.repeat(64) } }] };
    return { source, bc, productId, row };
  }
  async function restore(f: Awaited<ReturnType<typeof fixture>>) {
    const failures: Array<{ type: string; id: string; reason: string }> = [];
    const ids = new Map<string, number>([['finance-base-codes:80', f.bc.id], ['finance-products:50', f.productId], ['user:20', admin.id]]);
    await ds.transaction(async em => {
      em.queryRunner!.data.legacyImport = true;
      await restoreBaseVerifications({ em, companyId: admin.companyId, sourceCompanyId: 3, lookup: (type, id) => ids.get(`${type}:${id}`), createdIds: new Set([f.bc.id]), savepoint: fn => fn(), count: () => {}, fail: (type, id, reason) => failures.push({ type, id, reason }) }, f.source);
    });
    return failures;
  }
  it('值与来源一致才恢复已通过，保留原日期与人员证据，不调用今日人工验证', async () => {
    const f = await fixture(); expect(await restore(f)).toEqual([]);
    const bc = await ds.manager.findOneByOrFail(ResourceRecord, { id: f.bc.id });
    expect(bc.status).toBe('verified'); expect(bc.data.verifiedAt).toBe('2026-06-15');
    expect(bc.data._legacyVerifiedAt).toBe('2026-06-15 12:34:56'); expect(bc.data._legacyVerifiedBy).toBe(20);
    expect(bc.data.signature).toBe((await buildSnapshot(ds.manager, admin.companyId, bc)).signature);
  });
  it('转换成本不同不沿用旧审批，保留待验证并返回明确失败', async () => {
    const f = await fixture(); f.row.report.snapshot.profile.cost_price += 1;
    expect(await restore(f)).toEqual([expect.objectContaining({ type: 'base-verification', reason: expect.stringContaining('转换前后基础编码成本不一致') })]);
    expect((await ds.manager.findOneByOrFail(ResourceRecord, { id: f.bc.id })).status).toBe('pending');
  });
  it('明确按旧成本记录重算时核对独立依据，保留原审核证据并记录缓存差异', async () => {
    const f = await fixture(); f.row.report.snapshot.profile.cost_price = 12.5;
    Object.assign(f.row, { costBasis: { policy: 'source-purchase-records-with-composition-recalculation', costCents: 1150, components: [{ recordId: '1', productId: '50', unitCost: '10.0000', freight: '1', handling: '0.5', quantity: '1' }] } });
    f.source.sourceRows!.push({ table: 'finance_product_archive_costs', key: '1', row: { id: 1, company_id: 3, product_id: '50', unit_cost: '10.0000' } }, { table: 'finance_products', key: '50', row: { id: '50', company_id: 3, payload_json: { freightAmount: 1, handlingAmount: 0.5 } } });
    expect(await restore(f)).toEqual([]);
    const bc = await ds.manager.findOneByOrFail(ResourceRecord, { id: f.bc.id });
    expect(bc.status).toBe('verified'); expect(bc.data._legacyCostChange).toMatchObject({ fromCents: 1250, toCents: 1150 });
    expect(bc.data.migrationCostNote).toContain('原编码缓存成本12.5元，迁入成本11.5元');
    const noCost = { ...admin, permissions: { isCompanyAdmin: false, allow: ['resource.finance-base-codes.view'], deny: [] } };
    const hidden = (await svc.resources.get(noCost, 'finance-base-codes', f.bc.id)).data;
    expect(hidden.migrationCostNote).toBeUndefined(); expect(hidden._legacyCostChange).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toMatch(/fromCents|toCents|1250|1150/);
  });
  it('旧OEM证明不能再排除原料采购价，也不能伪造原料金额', async () => {
    const f=await fixture();
    const node:any={recordId:'1',productId:'50',unitCost:'10.0000',freight:'1',handling:'0.5',quantity:'1',includePurchase:false};
    Object.assign(f.row,{costBasis:{policy:'source-purchase-records-with-composition-recalculation',costCents:1150,components:[node]}});
    f.source.sourceRows!.push({table:'finance_product_archive_costs',key:'1',row:{id:1,company_id:3,product_id:'50',unit_cost:'10.0000',source_type:'production_bom'}},{table:'finance_products',key:'50',row:{id:'50',company_id:3,archive_key:'purchased',supply_mode:'supplier_oem',payload_json:{freightAmount:1,handlingAmount:0.5,rawMaterialPurchasePrice:10}}});
    expect((await restore(f))[0].reason).toContain('禁止仅按包材');
    Object.assign(node,{includePurchase:true,purchaseBasis:'explicit-oem-raw-input',rawMaterialPurchasePrice:'11'});
    expect((await restore(f))[0].reason).toContain('原料采购价');
    node.rawMaterialPurchasePrice='10';
    expect(await restore(f)).toEqual([]);
  });
  it('旧审批需复核时不伪造通过，上传重量不一致也会阻止沿用', async () => {
    const f = await fixture(); f.row.report.status = 'reverify';
    expect((await restore(f))[0].reason).toContain('原差异基线');
    f.row.report.status = 'verified'; f.row.report.snapshot.profile.weighing_weight /= 2;
    await ds.query("UPDATE resource_records SET data=JSON_SET(data,'$.weightG',?) WHERE id=?", [f.row.report.snapshot.profile.weighing_weight * 1000, f.bc.id]);
    expect((await restore(f))[0].reason).toContain('上传重量');
    expect((await ds.manager.findOneByOrFail(ResourceRecord, { id: f.bc.id })).status).toBe('pending');
  });
  it('组合沿原确认恢复，并逐行核对上传选项；来源组成被改时不会再次恢复通过', async () => {
    const f = await fixture(); expect(await restore(f)).toEqual([]);
    const platformId = (await svc.resources.create(admin, 'finance-platforms', { code: 'TB', name: '淘宝' })).id;
    const scenarioId = (await svc.resources.create(admin, 'finance-scenarios', { code: 'standard', name: '标准', segment: '' })).id;
    const cat = (await svc.resources.create(admin, 'finance-categories', { archiveType: 'bundle', code: 'ZH', name: '组合类' })).id;
    const code = `ZH-${randomBytes(4).toString('hex').toUpperCase()}`;
    const id = (await svc.resources.create(admin, 'finance-bundles', { platformId, scenarioId, bundleCategoryId: cat, manualCode: code, manualStyleCode: code, manualName: '原组合', manualShortName: '原组合', manualPropertiesValue: '2千克', baseUnit: '千克', manualReason: '测试保留来源' })).id;
    const lineId = (await svc.resources.create(admin, 'finance-bundle-lines', { bundleId: id, baseCodeId: f.bc.id, role: 'main', qty: 2, unit: 'KG', includeInJst: true })).id;
    const oldLine = { id: 301, company_id: 3, bom_id: 22, component_type: 'base_code', base_code_id: 80, role: 'main', quantity: '2', sort_order: 0, include_in_jst_bundle: 1, is_required: 1, loss_rate: '0', cost_bucket: 'purchase', cost_treatment: 'include' };
    f.source.sourceRows!.push(
      { table: 'finance_product_bundle_codes', key: '300', row: { id: 300, company_id: 3, bom_id: 22 } },
      { table: 'finance_product_bundle_bom_lines', key: '301', row: oldLine },
      { table: 'finance_bundle_data_verifications', key: '[3,300]', row: { company_id: 3, base_code_id: 300, verified_at: '2026-06-15 12:34:56', verified_by: 20, composition_signature: 'b'.repeat(64) } },
      { table: 'legacy_verification_reports', key: 'bundle:300', row: { id: '300', company_id: 3, kind: 'bundle', report: { status: 'verified', issues: [], verifiedAt: '2026-06-15 12:34:56', signature: 'b'.repeat(64), snapshot: { profile: { final_code: code, final_style_code: code, product_name: '原组合', short_name: '原组合', properties_value: '2千克', base_unit: '千克', cost_price: 23, weighing_weight: 2 } }, components: [{ quantity: 2, unitName: '千克', costPrice: 11.5, weight: 1 }] } } },
    );
    const ids = new Map([['finance-bundles:300', id], ['finance-bundle-lines:300:301', lineId], ['finance-base-codes:80', f.bc.id], ['user:20', admin.id]]);
    const verify = async () => {
      const errors: string[] = [];
      await ds.transaction(async em => { em.queryRunner!.data.legacyImport = true; await restoreBundleVerifications({ em, companyId: admin.companyId, sourceCompanyId: 3, lookup: (t, old) => ids.get(`${t}:${old}`), createdIds: new Set([id]), savepoint: fn => fn(), count: () => {}, fail: (_t, _id, reason) => errors.push(reason) }, f.source); });
      return errors;
    };
    expect(await verify()).toEqual([]);
    expect((await ds.manager.findOneByOrFail(ResourceRecord, { id })).status).toBe('verified');
    await ds.query("UPDATE resource_records SET status='pending' WHERE id=?", [id]); oldLine.include_in_jst_bundle = 0;
    expect((await verify())[0]).toContain('includeInJst');
    expect((await ds.manager.findOneByOrFail(ResourceRecord, { id })).status).toBe('pending');
  });
});
