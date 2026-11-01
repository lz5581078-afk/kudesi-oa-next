/** 商品档案迁移映射（纯转换，不连旧库）：单位列表、档案单位编码、多构成、成本六类、专属品 */
import { RESOURCE_DEFS, COST_BUCKETS, COST_SOURCE_TYPES } from '@kudesi/shared';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mapping = require('../../../../scripts/migration/product-mapping.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rules = require('../../../../scripts/migration/mapping-rules.json');

const defs = RESOURCE_DEFS as never;

describe('旧组合构成显式选项', () => {
  it('保留包装上传、非必需、原单位、损耗、成本处理、次序、有效期和说明', () => {
    expect(mapping.bundleLineExtras({ role: 'package', is_required: 0, include_in_jst_bundle: 1, loss_rate: '0.1250', cost_bucket: 'shipping_package', cost_treatment: 'reference_only', sort_order: 7, effective_from: '2026-01-01', effective_to: '2026-12-31', remark: '原组成说明' }, 'EA')).toEqual({ unit: 'EA', lossRate: 0.125, isRequired: false, includeInJst: true, costBucket: 'shipping_package', costTreatment: 'reference_only', sortOrder: 7, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', note: '原组成说明' });
    expect(mapping.bundleLineExtras({ role: 'main', is_required: 1, include_in_jst_bundle: 0 }, 'G')).toMatchObject({ isRequired: true, includeInJst: false, unit: 'G' });
  });
  it('缺少来源选项时不按用途猜测上传和必需', () => {
    expect(() => mapping.bundleLineExtras({ is_required: 1 }, 'G')).toThrow('无法对应');
    expect(() => mapping.bundleLineExtras({ is_required: null, include_in_jst_bundle: 1 }, 'G')).toThrow('无法对应');
  });
});

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


describe('空库全量迁移的历史单位与排序', () => {
  it('组合分类字典独立迁入，父级及状态保留，不和商品分类的数字ID合并', () => {
    const records = mapping.bundleCategoryRecords({ finance_product_code_dictionary: [
      { id: 92, dictionary_type: 'bundle_category', item_name: '组合根', item_code: 'ZH', status: 'active', sort_order: -1 },
      { id: 102, parent_id: 92, dictionary_type: 'bundle_category', item_name: '组合叶', item_code: 'ZHY', status: 'inactive' },
      { id: 93, dictionary_type: 'product_category' },
    ] });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ id: 'bundle-dict:92', data: { archiveType: 'bundle', code: 'ZH', sort: 0 } });
    expect(records[1]).toMatchObject({ status: 'inactive', data: { parentId: { legacyRef: { type: 'finance-categories', id: 'bundle-dict:92' } } } });
    expect(() => mapping.bundleCategoryRecords({ finance_product_code_dictionary: [{ id: 1, parent_id: 9, dictionary_type: 'bundle_category', status: 'active' }] })).toThrow('父级');
  });
  it('尺寸规格转换所用的计价单位也进入发货物料字典，不混入其他种类', () => {
    const cat = mapping.buildUnitCatalog({ defs, tables: { finance_products: [
      { archive_key: 'shipping_material', amount: '80mmx60m', unit: '毫米', payload: { purchaseSpecification: '张' } },
      { archive_key: 'raw', amount: '1', unit: '克', payload: { purchaseSpecification: '斤' } },
    ] }, payloadOf: (r: { payload: object }) => r.payload });
    expect(cat.codeOf('shipping_unit', '张')).toBeTruthy();
    expect(cat.codeOf('shipping_unit', '毫米')).toBeTruthy();
    expect(cat.codeOf('spec_unit', '张')).toBeUndefined();
    expect(cat.codeOf('spec_unit', '斤')).toBeUndefined();
  });
  it('档案用到但单位表没有的名称仍建目录，已存编码不重复创建单位', () => {
    const cat = mapping.buildUnitCatalog({defs,tables:{finance_product_units:[{id:1,unit_name:'克',unit_code:'G'}],finance_products:[{archive_key:'raw',unit:'G'},{archive_key:'raw',unit:'个'},{archive_key:'raw',unit:'历史自定义单位'},{archive_key:'shipping_material',unit:'个',payload:{productPackagingUnit:'盒'}}]},payloadOf:(r:{payload?:object})=>r.payload||{}});
    expect(cat.codeOf('spec_unit','G')).toBe('G');
    expect(cat.records.filter((r:{data:{kind:string;code:string}})=>r.data.kind==='spec_unit'&&r.data.code==='G')).toHaveLength(1);
    expect(cat.codeOf('spec_unit','个')).toBe('EA');
    expect(cat.codeOf('shipping_unit','个')).toBe('EA');
    expect(cat.records.some((r:{data:{name:string}})=>r.data.name==='历史自定义单位')).toBe(true);
    expect(cat.codeOf('packaging_unit','盒')).toBeTruthy();
  });
  it('负数排序转换为非负序位，保留先后与并列时的ID顺序，不改原行', () => {
    const rows=[{id:'10',sort_order:-1},{id:'2',sort_order:-1},{id:'3',sort_order:0},{id:'1',sort_order:100}];
    expect([...mapping.nonnegativeSortRanks(rows)]).toEqual([['2',0],['10',1],['3',2],['1',3]]);
    expect(rows[0].sort_order).toBe(-1);
    expect(()=>mapping.nonnegativeSortRanks([{id:1,sort_order:'invalid'}])).toThrow();
  });
});
