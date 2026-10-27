import { describe, expect, it } from 'vitest';
import { CATEGORY_ROOTS, getResourceDef, RESOURCE_DEFS, resourceTabCondition, resourceTabInitial, resourceTabOf, resourceTabOptions } from './index';

describe('页签再拆分（外购成品：原装采购成品 / 供应商 OEM 成品）', () => {
  const def = getResourceDef('finance-products')!;

  it('商品档案的页签里没有合并的“外购成品”，换成旧系统的两个入口，其余类型不变', () => {
    const tabs = resourceTabOptions(def).map((o) => `${o.value}:${o.label}`);
    expect(tabs).toEqual([
      'raw:原料档案', 'self_made:自产成品档案', 'original_purchase:原装采购成品档案', 'supplier_oem:供应商 OEM 成品档案', 'package:产品包装档案', 'shipping_material:发货物料档案', 'oem_package:OEM包装档案',
    ]);
    expect(resourceTabOptions(getResourceDef('phones')!)).toEqual(getResourceDef('phones')!.fields.find((f) => f.key === 'usageType')!.options);
  });

  it('页签条件：拆出的页签落到“外购 + 采购方式”，原装采购把没填的也算上；旧的合并值和别的类型不受影响', () => {
    expect(resourceTabCondition(def, 'original_purchase')).toEqual({ field: 'archiveType', value: 'purchased', split: { field: 'supplyMode', value: 'original_purchase', orMissing: true } });
    expect(resourceTabCondition(def, 'supplier_oem')).toEqual({ field: 'archiveType', value: 'purchased', split: { field: 'supplyMode', value: 'supplier_oem', orMissing: false } });
    expect(resourceTabCondition(def, 'purchased')).toEqual({ field: 'archiveType', value: 'purchased' });
    expect(resourceTabCondition(def, 'raw')).toEqual({ field: 'archiveType', value: 'raw' });
    expect(resourceTabCondition(def, '')).toBeNull();
  });

  it('在页签下新建：预填档案类型和采购方式；记录的页签归属由现有字段推出（采购方式没填算原装采购）', () => {
    expect(resourceTabInitial(def, 'supplier_oem')).toEqual({ archiveType: 'purchased', supplyMode: 'supplier_oem' });
    expect(resourceTabInitial(def, 'original_purchase')).toEqual({ archiveType: 'purchased', supplyMode: 'original_purchase' });
    expect(resourceTabInitial(def, 'raw')).toEqual({ archiveType: 'raw' });
    expect(resourceTabOf(def, { archiveType: 'purchased', supplyMode: 'supplier_oem' })).toBe('supplier_oem');
    expect(resourceTabOf(def, { archiveType: 'purchased', supplyMode: 'original_purchase' })).toBe('original_purchase');
    expect(resourceTabOf(def, { archiveType: 'purchased' })).toBe('original_purchase');
    expect(resourceTabOf(def, { archiveType: 'self_made' })).toBe('self_made');
  });

  it('配置自洽：拆分字段存在，拆出的页签都有对应的分类树（分类的所属类型），采购方式不再是下拉筛选', () => {
    for (const d of RESOURCE_DEFS.filter((x) => x.tabSplit)) {
      const split = d.tabSplit!;
      const tabField = d.fields.find((f) => f.key === d.tabsBy)!;
      expect(tabField.options?.some((o) => o.value === split.tab)).toBe(true);
      expect(d.fields.some((f) => f.key === split.field)).toBe(true);
      expect(split.options.some((o) => o.value === split.default)).toBe(true);
      for (const o of split.options) {
        expect(d.fields.find((f) => f.key === split.field)!.options?.some((x) => x.value === o.value)).toBe(true);
        expect(d.treeTabMap?.[o.value]).toEqual([o.value]);
        expect(CATEGORY_ROOTS.some((r) => r.value === o.value)).toBe(true);
      }
    }
    expect(def.filterBy).toEqual(['categoryId']);
  });
});
