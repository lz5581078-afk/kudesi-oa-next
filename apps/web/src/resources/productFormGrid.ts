import type { FieldDef } from '@kudesi/shared';

/**
 * 商品档案表单的 12 栏栅格：每个字段占几栏（按语义，不逐个写死）。
 * 12 = 整行（长文本、照片、分类选择、全名）；6 = 半行（名称、品牌、供应商…）；
 * 4 = 三个并排（采购价、运费、装卸费）；3 = 四个并排（规格数量、单位、包装规格、库存…）。
 */
export type FieldSpan = 3 | 4 | 6 | 12;

const SPAN_BY_KEY: Readonly<Record<string, FieldSpan>> = {
  basicInfoFullName: 12, capacities: 12, rawFinishedNames: 12, photos: 12, note: 12, zeroValueReason: 12, migrationNotice: 12, categoryId: 12,
  name: 6, brandId: 6, supplierId: 6, materialCode: 6, shape: 6, giftShortName: 6, giftCodeShortName: 6, printingCompany: 6, packagingCategory: 6, code: 12,
  specQty: 3, specUnit: 3, purchaseSpec: 3, productPackagingSpec: 3, productPackagingUnit: 3, dimensions: 3, dimensionUnit: 3, orderStock: 3, actualStock: 3, oemPackageWeightG: 3,
  purchasePrice: 4, freight: 4, handlingFee: 4,
};

export function fieldSpan(f: Pick<FieldDef, 'key' | 'type' | 'cascade'>): FieldSpan {
  const byKey = SPAN_BY_KEY[f.key];
  if (byKey) return byKey;
  if (f.type === 'textarea' || f.type === 'files' || f.type === 'attrs' || f.cascade) return 12;
  if (f.type === 'money') return 4;
  if (f.type === 'number' || f.type === 'decimal' || f.type === 'bool' || f.type === 'date') return 3;
  return 6;
}

/** 零值说明只在采购价 / 运费 / 装卸费明确填了 0（或已经写过说明、或有错误）时才需要看见 */
export function needsZeroReason(values: Record<string, unknown>): boolean {
  if (String(values.zeroValueReason ?? '').trim()) return true;
  return ['purchasePrice', 'freight', 'handlingFee'].some((k) => {
    const v = values[k];
    return v !== '' && v !== undefined && v !== null && Number(v) === 0;
  });
}
