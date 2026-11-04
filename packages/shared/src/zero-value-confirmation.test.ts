import { describe, expect, it } from 'vitest';
import { getResourceDef, readOnlyFieldKeys, restrictedFieldKeys } from './resources';
import { readZeroValueConfirmation, zeroValueContext } from './zero-value-confirmation';

const def = getResourceDef('finance-labor-costs')!;
const policy = def.zeroValueConfirmation!;
describe('零值确认上下文与权限', () => {
  it('按原工作名称、单位名、分类名顺序，首尾空格归一；缺少已选引用名称不能伪造为空', () => {
    expect(zeroValueContext(policy, { workName: ' 装袋 ', unitId: 1, workTypeId: 2 }, { unitId: '元/袋', workTypeId: '包装' })).toBe(JSON.stringify(['装袋', '元/袋', '包装']));
    expect(zeroValueContext(policy, { workName: '装袋', unitId: 1 }, {})).toBeNull();
    expect(zeroValueContext(policy, {}, {})).toBe('["","",""]');
  });
  it('一字原因也可明确确认；拒绝空/错误/超长信息，只提取原因和上下文', () => {
    expect(readZeroValueConfirmation({ reason: ' 赠 ', context: '[]', employeeId: 999 })).toEqual({ reason: '赠', context: '[]' });
    for (const value of [null, [], 'x', { reason: ' ', context: '[]' }, { reason: '赠', context: 1 }, { reason: 'x'.repeat(2001), context: '[]' }]) expect(readZeroValueConfirmation(value)).toBeNull();
  });
  it('确认内容跟随成本权限隐藏和禁止修改，不成为可选导入导出字段', () => {
    expect(restrictedFieldKeys(def, () => false).has(policy.confirmationField)).toBe(true);
    expect(readOnlyFieldKeys(def, permission => permission === 'product.cost.view').has(policy.confirmationField)).toBe(true);
    expect(readOnlyFieldKeys(def, () => true).has(policy.confirmationField)).toBe(false);
    expect(def.fields.some(field => field.key === policy.confirmationField)).toBe(false);
  });
});
