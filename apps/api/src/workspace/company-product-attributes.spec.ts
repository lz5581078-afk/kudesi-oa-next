import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ProductAttributes, ProductExclusiveDto } from './workspace.controller';

describe('公司产品最低售价输入边界', () => {
  const errors = (amount: unknown) => validateSync(plainToInstance(ProductAttributes, {priceRestricted:true,tags:[],minimumPriceCents:amount}));
  it.each([null, undefined, 1, 2990, 99999999999])('接受可空兼容及整数分 %s', amount => expect(errors(amount)).toHaveLength(0));
  it.each([0, -1, 1.5, NaN, Infinity, '2990', 100000000000])('拒绝非法金额 %s', amount => expect(errors(amount).length).toBeGreaterThan(0));
});

describe('手工专属输入校验',()=>{
  it.each([undefined,0,-1,1.5,'1'])('拒绝非法人员编号 %s',ownerId=>{
    expect(validateSync(plainToInstance(ProductExclusiveDto,{ownerId,reason:'分配',periodDays:30})).length).toBeGreaterThan(0);
  });
  it('允许明确解除和有效人员',()=>{
    for(const ownerId of [null,1])expect(validateSync(plainToInstance(ProductExclusiveDto,{ownerId,reason:'调整',periodDays:30}))).toHaveLength(0);
  });
});
