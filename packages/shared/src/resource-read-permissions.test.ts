import { describe, expect, it } from 'vitest';
import { getResourceDef, readOnlyFieldKeys, restrictedFieldKeys } from './resources';

describe('需要同时满足多个查看权限的资料字段', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])('上传内容同时要求成本与价格查看：%s/%s', (cost, price) => {
    const def = getResourceDef('finance-jst-uploads')!;
    const can = (key: string) => key === 'product.cost.view' ? cost : key === 'product.price.view' ? price : true;
    expect(restrictedFieldKeys(def, can).has('payload')).toBe(!(cost && price));
    expect(readOnlyFieldKeys(def, can).has('payload')).toBe(!(cost && price));
    expect(restrictedFieldKeys(def, can).has('skuId')).toBe(false);
  });
  it('单一permission与writePermission仍按原规则工作，不因新增空列表放行', () => {
    const def = getResourceDef('finance-jst-uploads')!;
    const restricted = { ...def, fields: [{ ...def.fields[0], permission: 'old.view', readPermissions: [], writePermission: 'old.edit' }] };
    expect(restrictedFieldKeys(restricted, () => false).has('skuId')).toBe(true);
    expect(restrictedFieldKeys(restricted, key => key === 'old.view').has('skuId')).toBe(false);
    expect(readOnlyFieldKeys(restricted, key => key === 'old.view').has('skuId')).toBe(true);
  });
});
