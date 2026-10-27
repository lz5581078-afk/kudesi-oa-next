import { describe, expect, it } from 'vitest';
import { archiveQualityFields, archiveQualityIssues, mergeQualityReasons, parseQualityReasons } from './archive-quality';

const raw = { archiveType: 'raw', name: '苹果', categoryId: 1, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 100, handlingFee: 50 };

describe('核算资料确认', () => {
  it('齐全的原料没有问题；采购价可以不填（取供货来源）', () => {
    expect(archiveQualityIssues(raw, { canCost: true })).toEqual([]);
    expect(archiveQualityIssues({ ...raw, purchasePrice: undefined }, { canCost: true })).toEqual([]);
  });
  it('缺项和零值：零值要写原因，原因按“项目：原因”写在零值说明里', () => {
    const v = { ...raw, purchaseSpec: '', freight: 0, handlingFee: 0, zeroValueReason: '运费：自提' };
    const msgs = archiveQualityIssues(v, { canCost: true }).map((i) => i.message);
    expect(msgs).toEqual(['系统规格未填写', '装卸费为0，尚未明确确认']);
  });
  it('没有成本权限的人不检查成本项', () => {
    expect(archiveQualityFields({ ...raw }, { canCost: false }).map((f) => f.id)).not.toContain('freight');
  });
  it('人工修正重量为 0 要确认“不计重量”；自动换算的不检查', () => {
    expect(archiveQualityIssues({ ...raw, weightManual: true, weightG: 0 }, { canCost: false }).map((i) => i.message)).toEqual(['重量为0，尚未明确确认']);
    expect(archiveQualityIssues({ ...raw, weightManual: true, weightG: 0, zeroValueReason: '重量：不计重量的赠品' }, { canCost: false })).toEqual([]);
    expect(archiveQualityFields(raw, { canCost: false }).some((f) => f.id === 'weightG')).toBe(false);
  });
  it('包装类：容量至少一行、填了尺寸要有单位', () => {
    const pkg = { archiveType: 'package', name: '盒', categoryId: 1, brandId: 1, specQty: 1, specUnit: 'EA', packagingCategory: 'box', capacities: '', dimensions: '1×2×3', purchasePrice: 1, freight: 1, handlingFee: 1 };
    expect(archiveQualityIssues(pkg, { canCost: true }).map((i) => i.message)).toEqual(['容量必须大于0', '尺寸单位未填写']);
  });
  it('自制品已有构成：包装组成、人力组成为 0 项要确认不需要', () => {
    const made = { archiveType: 'self_made', name: '礼盒', categoryId: 1, brandId: 1, productPackagingSpec: '500G袋', specQty: 1, specUnit: 'BOX', freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' };
    expect(archiveQualityIssues(made, { canCost: true, composition: { packaging: 0, labor: 1 } }).map((i) => i.message)).toEqual(['包装组成为0，尚未明确确认']);
    expect(archiveQualityIssues(made, { canCost: true })).toEqual([]);
  });
  it('原因解析与合并：同项覆盖、其它行保留', () => {
    expect(parseQualityReasons('运费：自提\n装卸费: 无')).toEqual({ 运费: '自提', 装卸费: '无' });
    expect(mergeQualityReasons('运费：自提\n备注行', { 运费: '到付', 重量: '不计' })).toBe('运费：到付\n重量：不计\n备注行');
  });
});
