import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ProductAttributes } from './workspace.controller';

describe('公司产品最低售价输入边界', () => {
  const errors = (amount: unknown) => validateSync(plainToInstance(ProductAttributes, {priceRestricted:true,tags:[],minimumPriceCents:amount}));
  it.each([null, undefined, 1, 2990, 99999999999])('接受可空兼容及整数分 %s', amount => expect(errors(amount)).toHaveLength(0));
  it.each([0, -1, 1.5, NaN, Infinity, '2990', 100000000000])('拒绝非法金额 %s', amount => expect(errors(amount).length).toBeGreaterThan(0));
});
