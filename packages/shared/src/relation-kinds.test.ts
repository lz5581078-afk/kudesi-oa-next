import { describe, expect, it } from 'vitest';
import { RESOURCE_DEFS } from './resources';
import { RELATION_KIND_DEFS, isKnownRelationKind, relationKindLabel, relationKindOptions } from './relation-kinds';

describe('手工关联的关系类型（旧系统 15 种 link 关系）', () => {
  it('每种关系的两端都是存在的资料类型（员工除外），名称不超过 16 个字', () => {
    const keys = new Set(RESOURCE_DEFS.map((d) => d.key));
    for (const d of RELATION_KIND_DEFS) {
      expect(keys.has(d.source), d.key).toBe(true);
      expect(d.target === 'user' || keys.has(d.target), d.key).toBe(true);
      expect(d.label.length).toBeLessThanOrEqual(16);
      expect(d.reverse.length).toBeLessThanOrEqual(16);
    }
  });
  it('按当前资料+目标资料给选项；反向看用反向名称；没定义的给“手工关联”', () => {
    expect(relationKindOptions('phones', 'stores')).toEqual([{ value: '绑定店铺', label: '绑定店铺', hint: '同一手机号在同一平台只允许关联一个店铺' }]);
    expect(relationKindOptions('stores', 'phones')[0]).toMatchObject({ value: '绑定店铺', label: '绑定手机号' });
    expect(relationKindOptions('phones', 'fixed-assets')[0].value).toBe('手工关联');
    expect(relationKindLabel('绑定店铺', 'stores', 'phones')).toBe('绑定手机号');
    expect(relationKindLabel('绑定店铺', 'phones', 'stores')).toBe('绑定店铺');
    expect(relationKindLabel('历史值', 'phones', 'stores')).toBe('历史值');
  });
  it('服务端校验：旧通用类型和手工关联总是认；带类型时这一对必须有这种关系', () => {
    expect(isKnownRelationKind('授权')).toBe(true);
    expect(isKnownRelationKind('绑定店铺', 'phones', 'stores')).toBe(true);
    expect(isKnownRelationKind('绑定店铺', 'phones', 'licenses')).toBe(false);
    expect(isKnownRelationKind('乱写')).toBe(false);
  });
});
