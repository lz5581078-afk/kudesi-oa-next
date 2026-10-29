/** 迁移适配器的商品档案部分：用假的旧库（内存表）跑完整读取，不连任何真实数据库 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RESOURCE_DEFS } from '@kudesi/shared';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adapter = require('../../../../scripts/migration/legacy-adapter.cjs');

const company = { id: 7, name: '测试公司' };
const payload = (o: Record<string, unknown>) => JSON.stringify(o);
const tables: Record<string, Array<Record<string, unknown>>> = {
  companies: [company],
  finance_product_categories: [
    { id: 1, company_id: 7, archive_key: 'raw', parent_id: null, name: '水果', category_code: 'SG', sort_order: 1, status: 'active', payload_json: '{}' },
    { id: 2, company_id: 7, archive_key: 'package', parent_id: null, name: '袋类', category_code: 'DL', sort_order: 1, status: 'active', payload_json: '{}' },
  ],
  finance_product_units: [{ id: 1, company_id: 7, unit_name: '千克', unit_code: 'KG', sort_order: 1 }, { id: 2, company_id: 7, unit_name: '桶', unit_code: '', sort_order: 2 }],
  finance_product_packaging_units: [{ id: 1, company_id: 7, unit_name: '袋', unit_code: 'D', sort_order: 1 }],
  finance_shipping_material_units: [],
  finance_products: [
    { id: 'raw-1', company_id: 7, archive_key: 'raw', category_id: 1, product_code: 'YL-SG-1', product_name: '苹果', brand: '', amount: '1', unit: '千克', status: 'normal', payload_json: payload({ giftShortName: '苹', giftCodeShortName: 'pg', materialCode: 'SC001', purchaseSpecification: '千克', freightAmount: '1.5', handlingAmount: '0.5', purchasePrice: '8.5' }) },
    { id: 'pkg-1', company_id: 7, archive_key: 'package', category_id: 2, product_code: 'BZ-DL-1', product_name: '蛇皮袋', brand: '', amount: '1', unit: '千克', weighing_weight: '14', status: 'normal', payload_json: payload({ packagingCategory: '蛇皮袋', dimensionUnit: '厘米', dimensions: '20×15', capacities: ['500ML'], weightUnit: 'g' }) },
  ],
  finance_product_archive_costs: [
    { id: 1, company_id: 7, product_id: 'raw-1', cost_type: 'transport', unit_cost: '0.1234', unit_name: '千克', effective_from: '2026-01-01', effective_to: null, source_type: '本季成本表', manual_override: 0, status: 'active', remark: '调运' },
    { id: 2, company_id: 7, product_id: 'raw-1', cost_type: 'purchase', unit_cost: '8.5000', unit_name: '千克', effective_from: '2026-01-01', effective_to: null, source_type: 'manual', manual_override: 1, manual_lock_reason: '手工价', status: 'active' },
  ],
  finance_product_base_codes: [
    { id: 11, company_id: 7, product_name: '礼盒', short_name: '礼盒', final_code: 'LH-1', final_style_code: 'LH', source_product_id: null, spec_quantity: '2', spec_unit_dictionary_id: 5, status: 'active' },
    { id: 12, company_id: 7, product_name: '苹果', final_code: 'SG-1', final_style_code: 'SG', source_product_id: 'raw-1', status: 'active' },
  ],
  finance_product_code_links: [
    { id: 1, company_id: 7, base_code_id: 11, product_id: 'raw-1', is_primary: 1, quantity: '2.000000', sort_order: 1 },
    { id: 2, company_id: 7, base_code_id: 11, product_id: 'pkg-1', is_primary: 0, quantity: '1.000000', sort_order: 2, remark: '包装' },
    { id: 3, company_id: 7, base_code_id: 12, product_id: 'raw-1', is_primary: 1, quantity: '1.000000', sort_order: 1 },
  ],
  finance_product_code_dictionary: [{ id: 5, company_id: 7, dictionary_type: 'spec_unit', item_name: '千克', item_code: 'KG' }],
  product_exclusive_grants: [{ id: 1, company_id: 7, base_code_id: 12, owner_id: 3 }, { id: 2, company_id: 7, base_code_id: 11, owner_id: 4 }],
};

let appDir: string;
beforeAll(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-app-'));
  fs.writeFileSync(path.join(appDir, 'package.json'), '{"name":"fake-legacy"}');
  fs.writeFileSync(path.join(appDir, '.env'), 'SECRET_KEY=x\n');
  fs.mkdirSync(path.join(appDir, 'node_modules/dotenv'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'node_modules/dotenv/index.js'), 'exports.parse=()=>({});');
  fs.mkdirSync(path.join(appDir, 'node_modules/mysql2'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'node_modules/mysql2/promise.js'), `
const tables=${JSON.stringify(tables)};
exports.createConnection=async()=>({
  beginTransaction:async()=>{},rollback:async()=>{},end:async()=>{},
  query:async(sql)=>{
    if(/information_schema/.test(sql))return [Object.entries(tables).flatMap(([t,rows])=>Object.keys(rows[0]||{company_id:1}).map(c=>({t,c})))];
    const m=/FROM \\\`(\\w+)\\\` t/.exec(sql);
    if(m)return [tables[m[1]]||[]];
    return [[]];
  }
});`);
  fs.mkdirSync(path.join(appDir, 'server/core'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'server/core/business-secrets.js'), 'exports.createBusinessSecretCodec=()=>({decrypt:(x)=>x});');
  process.env.LEGACY_APP_DIR = appDir;
});
afterAll(() => { delete process.env.LEGACY_APP_DIR; fs.rmSync(appDir, { recursive: true, force: true }); });

describe('迁移适配器：商品档案（假旧库）', () => {
  it('包装类重量按“重量输入单位”换算（14 克不是 14 千克），并带上重量输入单位', async () => {
    const o = await adapter.read({ sourceCompanyId: 7, definitions: RESOURCE_DEFS, parseWeightScope: () => null });
    const pkg = o.records.find((r: { type: string; id: string }) => r.type === 'finance-products' && r.id === 'pkg-1');
    expect(pkg.data.weightG).toBe(14);
    expect(pkg.data.weightUnit).toBe('g');
  });

  let out: { records: Array<{ type: string; id: string; data: Record<string, unknown>; status: string; notices?: string[] }>; exclusions: Array<{ type: string; id: string; reason: string }> };
  const of = (type: string) => out.records.filter((r) => r.type === type);
  beforeAll(async () => { out = await adapter.read({ sourceCompanyId: 7, definitions: RESOURCE_DEFS, parseWeightScope: () => null }); });

  it('旧单位表和用到的包装类别、尺寸单位建成列表，且排在商品档案前面', () => {
    const units = of('finance-product-units');
    expect(units.map((u) => `${u.data.kind}:${u.data.name}:${u.data.code}`)).toEqual(expect.arrayContaining(['spec_unit:千克:KG', 'packaging_unit:袋:D']));
    expect(units.find((u) => u.data.name === '桶')?.data.code).toMatch(/^[A-Z0-9]+$/); // 没有旧编码的自动生成
    expect(units.some((u) => u.data.kind === 'packaging_category' && u.data.name === '蛇皮袋')).toBe(true);
    expect(units.find((u) => u.data.kind === 'dimension_unit')?.data.code).toBe('cm');
    const firstProduct = out.records.findIndex((r) => r.type === 'finance-products');
    expect(out.records.findIndex((r) => r.type === 'finance-product-units')).toBeLessThan(firstProduct);
  });

  it('商品档案带上赠品简称、赠品编码简称、生产编码，单位名称换成编码', () => {
    const raw = of('finance-products').find((r) => r.id === 'raw-1')!;
    expect(raw.data).toMatchObject({ giftShortName: '苹', giftCodeShortName: 'pg', materialCode: 'SC001', specUnit: 'KG' });
    const pkg = of('finance-products').find((r) => r.id === 'pkg-1')!;
    expect(pkg.data.dimensionUnit).toBe('cm');
    expect(pkg.data.packagingCategory).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('六类成本记录按旧记录原样迁入：别名转新取值、保留锁定和原因', () => {
    const costs = of('finance-product-costs');
    expect(costs).toHaveLength(2);
    expect(costs.find((c) => c.id === '1')?.data).toMatchObject({ costType: 'transfer', sourceType: 'seasonal_cost_table', unitName: '千克', effectiveFrom: '2026-01-01' });
    expect(costs.find((c) => c.id === '2')?.data).toMatchObject({ costType: 'purchase', manualOverride: true, manualLockReason: '手工价' });
  });

  it('多行商品关联的基础编码迁成多构成，带构成行；单商品编码不变', () => {
    const multi = of('finance-base-codes').find((r) => r.id === '11')!;
    expect(multi.data).toMatchObject({ origin: 'composed', codeSpecQty: 2, codeSpecUnit: 'KG', varietyName: '礼盒' });
    expect(of('finance-base-codes').find((r) => r.id === '12')!.data.origin).toBeUndefined();
    const lines = of('finance-base-code-lines');
    expect(lines.map((l) => l.data.qty)).toEqual([2, 1]);
    expect(lines.map((l) => l.data.role)).toEqual(['main', 'auxiliary']);
    expect(lines.every((l) => l.id.startsWith('11:'))).toBe(true);
  });

  it('专属品授予只记排除清单，不凭空建授权', () => {
    expect(of('finance-product-exclusives')).toHaveLength(0);
    expect(out.exclusions.filter((e) => e.type === 'finance-product-exclusives').map((e) => e.id).sort()).toEqual(['1', '2']);
  });
});
