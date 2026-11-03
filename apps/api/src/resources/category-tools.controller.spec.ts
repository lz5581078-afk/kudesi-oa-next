import 'reflect-metadata';
import { validate } from 'class-validator';
import { CodePreviewDto } from './category-tools.controller';

describe('商品编码预览输入', () => {
  it.each([1, 2.5, '2.50', '25*33+4', '净含量500g', '规'.repeat(200)])('接受名称规格 %s', async specQty => {
    expect(await validate(Object.assign(new CodePreviewDto(), { archiveType: 'shipping_material', specQty, purchaseSpec: '卷' }))).toEqual([]);
  });
  it.each([{}, [], true, Infinity, '规'.repeat(201)])('拒绝非文字数字或过长规格', async specQty => {
    const errors = await validate(Object.assign(new CodePreviewDto(), { archiveType: 'shipping_material', specQty }));
    expect(errors.some(error => error.property === 'specQty')).toBe(true);
  });
});
