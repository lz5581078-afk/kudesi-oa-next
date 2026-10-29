import { describe, expect, it } from 'vitest';
import { FINANCE_RESOURCE_DEFS } from './finance-resources';
import { BLOCK_FIELDS, PRODUCT_LAYOUTS, isBlock, layoutFieldKeys, layoutFieldMeta, productFieldDef, productFormProblems, productLayoutKey, type ProductLayoutKey } from './product-layout';

const def = FINANCE_RESOURCE_DEFS.find((d) => d.key === 'finance-products')!;
const SAMPLE: Record<ProductLayoutKey, Record<string, unknown>> = {
  raw: { archiveType: 'raw' },
  self_made: { archiveType: 'self_made' },
  purchased_original: { archiveType: 'purchased', supplyMode: 'original_purchase' },
  purchased_oem: { archiveType: 'purchased', supplyMode: 'supplier_oem' },
  package: { archiveType: 'package' },
  oem_package: { archiveType: 'oem_package' },
  shipping_material: { archiveType: 'shipping_material' },
  custom: { archiveType: 'my_custom_type' },
};
const KEYS = Object.keys(PRODUCT_LAYOUTS) as ProductLayoutKey[];

describe('商品档案布局（详情、新增、编辑共用的一份）', () => {
  it('档案类型 → 布局', () => {
    for (const k of KEYS) expect(productLayoutKey(SAMPLE[k])).toBe(k);
  });

  it('布局里的字段都在字段定义里，且同一布局里不重复', () => {
    for (const k of KEYS) {
      const seen = new Set<string>();
      for (const s of PRODUCT_LAYOUTS[k].sections) for (const i of s.items) {
        const keys = isBlock(i) ? [] : [i.field];
        for (const key of keys) { expect(productFieldDef(key), `${k}:${key}`).toBeTruthy(); expect(seen.has(key), `${k} 重复 ${key}`).toBe(false); seen.add(key); }
      }
      for (const key of layoutFieldKeys(PRODUCT_LAYOUTS[k])) expect(productFieldDef(key), `${k}:${key}`).toBeTruthy();
    }
  });

  it('字段定义里的每个字段，至少出现在一种档案类型的布局里（没有字段被排丢）', () => {
    const all = new Set(KEYS.flatMap((k) => layoutFieldKeys(PRODUCT_LAYOUTS[k])));
    const lost = def.fields.map((f) => f.key).filter((k) => !all.has(k));
    expect(lost).toEqual([]);
  });

  it('字段的显示条件（showWhen）和布局一致：布局放了它的类型，条件都成立', () => {
    for (const k of KEYS) {
      const values = SAMPLE[k];
      for (const key of layoutFieldKeys(PRODUCT_LAYOUTS[k])) {
        const f = productFieldDef(key)!;
        if (f.showWhen && !['shape'].includes(key)) expect(f.showWhen.in, `${k}:${key}`).toContain(String(values[f.showWhen.field] ?? ''));
      }
    }
  });

  it('功能块包办的字段都存在', () => {
    for (const keys of Object.values(BLOCK_FIELDS)) for (const key of keys) expect(productFieldDef(key), key).toBeTruthy();
  });

  it('各类型分区顺序（旧版抽屉的顺序）', () => {
    const ids = (k: ProductLayoutKey) => PRODUCT_LAYOUTS[k].sections.map((s) => s.id);
    expect(ids('raw')).toEqual(['category', 'code', 'gift', 'base', 'finished', 'sources', 'measure', 'logistics', 'total', 'photos']);
    expect(ids('self_made')).toEqual(['category', 'code', 'base', 'production', 'result', 'logistics', 'total', 'photos']);
    expect(ids('purchased_original')).toEqual(['category', 'code', 'gift', 'base', 'pricing', 'logistics', 'total', 'photos']);
    expect(ids('purchased_oem')).toEqual(['category', 'code', 'gift', 'base', 'production', 'pricing', 'logistics', 'total', 'photos']);
    expect(ids('package')).toEqual(['category', 'code', 'base', 'capacities', 'production', 'stock', 'logistics', 'total', 'photos']);
    expect(ids('oem_package')).toEqual(ids('package'));
    expect(ids('shipping_material')).toEqual(['category', 'gift', 'base', 'code', 'sources', 'weight', 'logistics', 'total', 'photos']);
    expect(ids('custom')).toEqual(['category', 'code', 'base', 'cost', 'total', 'photos']);
  });

  it('赠品简称只在原料、外购成品、发货物料；生产编码只在原料、发货物料；品牌原料不填', () => {
    const has = (k: ProductLayoutKey, f: string) => layoutFieldKeys(PRODUCT_LAYOUTS[k]).includes(f);
    for (const k of KEYS) {
      expect(has(k, 'giftShortName')).toBe(['raw', 'purchased_original', 'purchased_oem', 'shipping_material'].includes(k));
      expect(has(k, 'materialCode')).toBe(['raw', 'shipping_material'].includes(k));
      expect(has(k, 'brandId')).toBe(k !== 'raw');
      expect(has(k, 'productPackagingSpec')).toBe(k === 'self_made');
      expect(has(k, 'capacities')).toBe(['package', 'oem_package'].includes(k));
      expect(has(k, 'rawFinishedNames')).toBe(k === 'raw');
      expect(has(k, 'oemPackageWeightG')).toBe(k === 'purchased_oem');
      expect(has(k, 'purchaseSpec')).toBe(['raw', 'self_made', 'purchased_original', 'purchased_oem', 'package', 'oem_package'].includes(k));
    }
  });

  it('必填矩阵（按旧版 saveProduct）', () => {
    const required = (k: ProductLayoutKey) => layoutFieldKeys(PRODUCT_LAYOUTS[k]).filter((f) => layoutFieldMeta(PRODUCT_LAYOUTS[k], f)!.required).sort();
    expect(required('raw')).toEqual(['archiveType', 'categoryId', 'name', 'purchaseSpec', 'specQty', 'specUnit'].sort());
    expect(required('self_made')).toEqual(['archiveType', 'brandId', 'categoryId', 'name', 'productPackagingSpec', 'productPackagingUnit', 'purchaseSpec'].sort());
    expect(required('purchased_original')).toEqual(['archiveType', 'brandId', 'categoryId', 'name', 'purchasePrice', 'purchaseSpec', 'specQty', 'specUnit'].sort());
    expect(required('purchased_oem')).toEqual(required('purchased_original'));
    expect(required('package')).toEqual(['archiveType', 'brandId', 'categoryId', 'name', 'packagingCategory', 'purchasePrice', 'purchaseSpec'].sort());
    expect(required('shipping_material')).toEqual(['archiveType', 'categoryId', 'name', 'specQty', 'specUnit'].sort());
  });

  it('旧版的叫法保留：名称规格 / 名称单位 / 原料生产编码 / 物料生产编码 / 原料采购价', () => {
    const label = (k: ProductLayoutKey, f: string) => layoutFieldMeta(PRODUCT_LAYOUTS[k], f)!.label;
    expect(label('self_made', 'specQty')).toBe('名称规格');
    expect(label('purchased_original', 'specUnit')).toBe('名称单位');
    expect(label('raw', 'materialCode')).toBe('原料生产编码');
    expect(label('shipping_material', 'materialCode')).toBe('物料生产编码');
    expect(label('shipping_material', 'specUnit')).toBe('规格单位');
    expect(label('purchased_oem', 'purchasePrice')).toBe('原料采购价');
    expect(label('purchased_original', 'purchasePrice')).toBe('采购价');
  });

  it('自制品名称规格/单位选填，不要求规格数量大于 0', () => {
    const p = productFormProblems({ archiveType: 'self_made', name: '有机肥', categoryId: 1, brandId: 1, productPackagingSpec: '500', productPackagingUnit: 'D', purchaseSpec: '千克' }, { canCost: true, composition: [{ group: 'raw', id: 3, qty: 2 }] });
    expect(p).toEqual({});
  });
});

describe('按类型的逐字段问题', () => {
  const ok = { categoryId: 1, name: '测试', brandId: 1, specQty: 1, specUnit: 'KG', purchaseSpec: '千克', purchasePrice: 100, freight: 0, handlingFee: 0 };
  it('原料：要系统规格、至少一条完整供货来源', () => {
    const p = productFormProblems({ archiveType: 'raw', categoryId: 1, name: '苹果', specQty: 1, specUnit: 'KG', freight: 0, handlingFee: 0 }, { canCost: true, sources: [] });
    expect(p.purchaseSpec).toBe('请填写系统规格');
    expect(p.supplySources).toContain('供货来源');
    const q = productFormProblems({ archiveType: 'raw', categoryId: 1, name: '苹果', specQty: 1, specUnit: 'KG', purchaseSpec: '斤', freight: 0, handlingFee: 0 }, { canCost: true, sources: [{ supplierId: 1, originArea: '山东', purchasePrice: 1000 }] });
    expect(q).toEqual({});
    // 没有成本编辑权限：来源不要求采购价
    expect(productFormProblems({ archiveType: 'raw', categoryId: 1, name: '苹果', specQty: 1, specUnit: 'KG', purchaseSpec: '斤' }, { canCost: false, sources: [{ supplierId: 1, originArea: '山东' }] })).toEqual({});
  });
  it('发货物料：每个来源要系统规格；重量必填', () => {
    const v = { archiveType: 'shipping_material', categoryId: 1, name: '纸箱', specQty: 1, specUnit: 'PCS', freight: 0, handlingFee: 0 };
    const p = productFormProblems(v, { canCost: true, sources: [{ supplierId: 1, originArea: '浙江', purchasePrice: 5 }] });
    expect(p.supplySources).toContain('系统规格');
    expect(p.weightG).toBe('请填写重量');
  });
  it('外购成品：品牌、名称规格、系统规格、采购价必填', () => {
    const p = productFormProblems({ archiveType: 'purchased', supplyMode: 'original_purchase', categoryId: 1, name: '种子', freight: 0, handlingFee: 0 }, { canCost: true });
    expect(Object.keys(p).sort()).toEqual(['brandId', 'purchasePrice', 'purchaseSpec', 'specQty', 'specUnit'].sort());
    expect(productFormProblems({ archiveType: 'purchased', supplyMode: 'original_purchase', ...ok }, { canCost: true })).toEqual({});
  });
  it('供应商 OEM 成品：包装行要选档案并填用量', () => {
    const v = { archiveType: 'purchased', supplyMode: 'supplier_oem', ...ok };
    expect(productFormProblems(v, { canCost: true, composition: [{ group: 'oem_package', id: null, qty: 1 }] }).composition).toContain('OEM 包装');
    expect(productFormProblems(v, { canCost: true, composition: [{ group: 'oem_package', id: 4, qty: 1 }] })).toEqual({});
  });
  it('自产成品：品牌、包装规格/单位、系统规格、至少一条组成', () => {
    const p = productFormProblems({ archiveType: 'self_made', categoryId: 1, name: '肥' }, { canCost: true, composition: [] });
    expect(Object.keys(p).sort()).toEqual(['brandId', 'composition', 'productPackagingSpec', 'productPackagingUnit', 'purchaseSpec'].sort());
    expect(productFormProblems({ archiveType: 'self_made', categoryId: 1, name: '肥', brandId: 1, productPackagingSpec: '1', productPackagingUnit: 'D', purchaseSpec: '斤' }, { canCost: true, composition: [{ group: 'labor', id: 1, qty: 0 }] }).composition).toContain('大于 0');
  });
  it('包装类：包装类别、品牌、至少一个容量、尺寸要单位、重量、系统规格、采购价', () => {
    const p = productFormProblems({ archiveType: 'package', categoryId: 1, name: '袋', dimensions: '20×15', freight: 0, handlingFee: 0 }, { canCost: true });
    expect(Object.keys(p).sort()).toEqual(['brandId', 'capacities', 'dimensionUnit', 'packagingCategory', 'purchasePrice', 'purchaseSpec', 'weightG'].sort());
    const q = productFormProblems({ archiveType: 'oem_package', categoryId: 1, name: '袋', brandId: 1, packagingCategory: 'bag', capacities: '500ML', weightG: 14, purchaseSpec: '个', purchasePrice: 30, orderStock: -1, freight: 0, handlingFee: 0 }, { canCost: true });
    expect(q).toEqual({ orderStock: '库存不能小于 0' });
  });
  it('运费、装卸费必填（自产成品除外），没成本权限的人不要求', () => {
    const v = { archiveType: 'purchased', supplyMode: 'original_purchase', ...ok, freight: undefined, handlingFee: undefined };
    expect(Object.keys(productFormProblems(v, { canCost: true })).sort()).toEqual(['freight', 'handlingFee']);
    expect(productFormProblems(v, { canCost: false })).toEqual({});
    expect(productFormProblems(v, { canCost: true, lenient: true })).toEqual({});
  });
});

describe('resolveProductSections（表单和详情共用的解析）', () => {
  it('套用这一类的叫法与必填，分区标题写进 group', async () => {
    const { resolveProductSections } = await import('./product-layout');
    const secs = resolveProductSections({ archiveType: 'raw' });
    const base = secs.find((s) => s.id === 'base')!;
    const spec = base.nodes.find((n) => n.kind === 'field' && n.field.key === 'specQty');
    expect(spec && spec.kind === 'field' && spec.field.label).toBe('规格');
    expect(spec && spec.kind === 'field' && spec.field.group).toBe(base.title);
    expect(secs.map((s) => s.id)).toEqual(['category', 'code', 'gift', 'base', 'finished', 'sources', 'measure', 'logistics', 'total', 'photos']);
  });
  it('没有成本权限时成本字段不出现；形态/款式没值不显示', async () => {
    const { resolveProductSections } = await import('./product-layout');
    const flat = (v: Record<string, unknown>, canUse: (p: string) => boolean) => resolveProductSections(v, { canUse }).flatMap((s) => s.nodes.flatMap((n) => (n.kind === 'field' ? [n.field.key] : n.fields.map((f) => f.key))));
    const none = flat({ archiveType: 'purchased', supplyMode: 'original_purchase' }, () => false);
    expect(none).not.toContain('purchasePrice');
    expect(none).not.toContain('freight');
    expect(none).not.toContain('shape');
    expect(flat({ archiveType: 'purchased', supplyMode: 'original_purchase', shape: '盒' }, () => true)).toContain('shape');
  });
});
