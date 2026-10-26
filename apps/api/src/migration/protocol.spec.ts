import { exactCents, legacyRef } from './protocol';
describe('迁移字段转换', () => {
  it('十进制定点换算，不用浮点舍入', () => {
    expect(exactCents('1.23')).toBe(123);
    expect(exactCents('0.290000')).toBe(29);
    expect(exactCents('-1.2')).toBe(-120);
    expect(exactCents('')).toBeUndefined();
    expect(() => exactCents('0.001')).toThrow();
    expect(() => exactCents('1e3')).toThrow();
    expect(() => exactCents('1000000000')).toThrow();
  });
  it('引用保留旧字符串ID，不提前强转为新数值', () => {
    expect(legacyRef('finance-products','archive-123')).toEqual({legacyRef:{type:'finance-products',id:'archive-123'}});
    expect(legacyRef('user',null)).toBeUndefined();
  });
});
