/** 商品档案迁移映射（纯转换，不连旧库）：单位列表、档案单位编码、多构成、成本六类、专属品 */
import { RESOURCE_DEFS, COST_BUCKETS, COST_SOURCE_TYPES } from '@kudesi/shared';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mapping = require('../../../../scripts/migration/product-mapping.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rules = require('../../../../scripts/migration/mapping-rules.json');

const defs = RESOURCE_DEFS as never;

describe('旧单位表 → 新“单位与规格”', () => {
  const tables = {
    finance_product_units: [
      { id: 2, unit_name: '千克', unit_code: 'KG', sort_order: 2 },
      { id: 1, unit_name: '克', unit_code: 'G', sort_order: 1 },
      { id: 3, unit_name: '桶', unit_code: '', sort_order: 3 },
    ],
    finance_product_packaging_units: [{ id: 9, unit_name: '袋', unit_code: 'bag', sort_order: 1 }],
    finance_shipping_material_units: [{ id: 5, unit_name: '卷', unit_code: 'ROLL', sort_order: 1 }],
    finance_products: [
      { id: 'p1', payload_json: JSON.stringify({ packagingCategory: '蛇皮袋', dimensionUnit: '厘米' }) },
      { id: 'p2', payload_json: { packagingCategory: '蛇皮袋' } },
      { id: 'p3', payload_json: '{坏json' },
    ],
  };
  const payloadOf = (p: { payload_json: unknown }) => { try { return typeof p.payload_json === 'string' ? JSON.parse(p.payload_json) : (p.payload_json as object); } catch { return {}; } };
  const cat = mapping.buildUnitCatalog({ tables, defs, payloadOf });

  it('三张旧表各自成一类，编码用旧编码（规范成大写字母数字），没有编码的按常用单位/拼音首字母生成', () => {
    const rec = (id: string) => cat.records.find((r: { id: string }) => r.id === id)?.data;
    expect(rec('spec_unit:1')).toMatchObject({ kind: 'spec_unit', name: '克', code: 'G', sortOrder: 1 });
    expect(rec('spec_unit:3')).toMatchObject({ name: '桶', code: expect.stringMatching(/^[A-Z0-9]+$/) });
    expect(rec('packaging_unit:9')).toMatchObject({ kind: 'packaging_unit', code: 'BAG' });
    expect(rec('shipping_unit:5')).toMatchObject({ kind: 'shipping_unit', code: 'ROLL' });
  });

  it('档案里用过的包装类别、尺寸单位都建成列表项，重复名称只建一次，内置名称用内置编码', () => {
    expect(cat.records.filter((r: { data: { kind: string } }) => r.data.kind === 'packaging_category')).toHaveLength(1);
    expect(cat.codeOf('packaging_category', '蛇皮袋')).toMatch(/^[A-Z0-9]+$/);
    expect(cat.codeOf('dimension_unit', '厘米')).toBe('cm');
  });

  it('每一类里编码不重复', () => {
    const seen = new Set<string>();
    for (const r of cat.records) { const k = `${r.data.kind}:${r.data.code}`; expect(seen.has(k)).toBe(false); seen.add(k); }
  });

  it('档案的单位名称转成编码：发货物料读发货物料单位，找不到的不猜', () => {
    const payload = { productPackagingUnit: '袋', packagingCategory: '蛇皮袋', dimensionUnit: '厘米' };
    expect(mapping.productUnitFields({ row: { archive_key: 'raw', unit: '千克' }, payload, catalog: cat })).toMatchObject({ specUnit: 'KG', productPackagingUnit: 'BAG', dimensionUnit: 'cm' });
    expect(mapping.productUnitFields({ row: { archive_key: 'shipping_material', unit: '卷' }, payload: {}, catalog: cat })).toEqual({ specUnit: 'ROLL' });
    expect(mapping.productUnitFields({ row: { archive_key: 'raw', unit: '不存在的单位' }, payload: {}, catalog: cat })).toEqual({});
  });
});

describe('多构成基础编码', () => {
  it('单商品不是多构成；多行取主要商品，数量和角色保留', () => {
    expect(mapping.composedFromLinks([{ id: 1, product_id: 'a', quantity: '1' }])).toBeNull();
    const c = mapping.composedFromLinks([
      { id: 2, product_id: 'b', quantity: '3.000000', is_primary: 0, sort_order: 2, remark: '赠' },
      { id: 1, product_id: 'a', quantity: '2.000000', is_primary: 1, sort_order: 1 },
    ]);
    expect(c.primaryProductId).toBe('a');
    expect(c.lines.map((l: { productId: string }) => l.productId)).toEqual(['a', 'b']);
    expect(c.lines[0].data).toMatchObject({ qty: 2, role: 'main' });
    expect(c.lines[1].data).toMatchObject({ qty: 3, role: 'auxiliary', remark: '赠' });
  });
});

describe('映射规则表', () => {
  const r = rules.resources as Record<string, { valueMaps?: Record<string, Record<string, string>>; policy?: string; tables: string[] }>;
  const keys = Object.keys(r);
  const field = (type: string, key: string) => RESOURCE_DEFS.find((d) => d.key === type)?.fields.find((f) => f.key === key);

  it('新增的资料类型都在资料配置里；单位列表排在商品档案前面（商品里存的是编码）', () => {
    for (const t of ['finance-product-units', 'finance-product-costs', 'finance-base-code-lines', 'finance-product-exclusives']) {
      expect(RESOURCE_DEFS.some((d) => d.key === t)).toBe(true);
      expect(keys).toContain(t);
    }
    expect(keys.indexOf('finance-product-units')).toBeLessThan(keys.indexOf('finance-products'));
    expect(keys.indexOf('finance-product-costs')).toBeGreaterThan(keys.indexOf('finance-products'));
  });

  it('成本记录：六类成本、来源类型的别名都落在新系统的取值里', () => {
    const buckets = COST_BUCKETS.map((o) => o.value);
    expect(buckets).toHaveLength(6);
    for (const v of Object.values(r['finance-product-costs'].valueMaps!.costType)) expect(buckets).toContain(v);
    const sources = COST_SOURCE_TYPES.map((o) => o.value);
    for (const v of Object.values(r['finance-product-costs'].valueMaps!.sourceType)) expect(sources).toContain(v);
    for (const k of Object.keys(r['finance-product-costs'].valueMaps!)) expect(field('finance-product-costs', k)).toBeTruthy();
  });

  it('商品档案新字段（赠品简称、赠品编码简称、生产编码、产品包装单位）有来源', () => {
    const a = (rules.resources['finance-products'].aliases) as Record<string, string[]>;
    for (const k of ['giftShortName', 'giftCodeShortName', 'materialCode', 'productPackagingUnit']) {
      expect(field('finance-products', k)).toBeTruthy();
      expect(a[k]?.[0]).toBe(`@json:$.${k}`);
    }
  });

  it('专属品不凭空补授权：按人工核对清单排除', () => {
    expect(r['finance-product-exclusives'].policy).toBe('review-exclusive');
  });
});
