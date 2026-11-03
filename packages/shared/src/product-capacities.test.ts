import { describe, expect, it } from 'vitest';
import { productCapacity, productCapacityText } from './product-capacities';
import { productFormProblems } from './product-layout';
describe('包装容量逐行读取', () => {
  it('单位可先填写；保留数量文字及小数，不把单位当成数量', () => {
    expect(productCapacity('KG')).toEqual({ quantityText: '', quantity: null, unit: 'KG' });
    expect(productCapacity('2.50KG')).toEqual({ quantityText: '2.50', quantity: 2.5, unit: 'KG' });
    expect(productCapacity('-2KG')).toEqual({ quantityText: '-2', quantity: -2, unit: 'KG' });
    expect(productCapacity('1e3KG')).toEqual({ quantityText: '1e3', quantity: 1000, unit: 'KG' });
  });
  it('每条非空容量都要有正数量及单位，不能只检查第一行', () => {
    for (const capacities of ['1KG\nKG', '1KG\n2', '1KG\n0G', '1KG\n-1G']) expect(productFormProblems({ archiveType: 'package', capacities }, { canCost: true }).capacities).toContain('每条容量');
    expect(productFormProblems({ archiveType: 'package', capacities: '1KG\n2.50G' }, { canCost: true }).capacities).toBeUndefined();
  });
  it('数字单位和E开头编码与数量分隔，单位先选的草稿也能恢复', () => {
    for (const unit of ['123', 'E3']) {
      const empty = productCapacityText('', unit);
      expect(productCapacity(empty)).toMatchObject({ quantityText: '', quantity: null, unit });
      const filled = productCapacityText('2.50', unit);
      expect(productCapacity(filled)).toEqual({ quantityText: '2.50', quantity: 2.5, unit });
    }
  });

});
