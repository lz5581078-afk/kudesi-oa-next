import { describe, expect, it } from 'vitest';
import { estimateFreight, majorityCluster, pickRule, ruleFreightCents, zoneSuggestions, type ExpressRule } from './freight';

const P = ['北京', '上海', '广东', '浙江', '江苏'];
const rule = (o: Partial<ExpressRule>): ExpressRule => ({ carrier: 'A', province: 'ALL', firstWeight: 1, firstPriceCents: 300, extraPriceCents: 100, ...o });

describe('运费预估', () => {
  it('首重+续重向上取整；固定价优先', () => {
    expect(ruleFreightCents(rule({}), 1)).toBe(300);
    expect(ruleFreightCents(rule({}), 2.2)).toBe(300 + 2 * 100);
    expect(ruleFreightCents(rule({ fixedPriceCents: 999 }), 5)).toBe(999);
    expect(ruleFreightCents({ carrier: 'A', province: 'ALL' }, 5)).toBeNull();
  });
  it('省份专属优先于全国；区间窄的优先；重量不在区间不可用', () => {
    const all = rule({ fixedPriceCents: 500 });
    const bj = rule({ province: '北京', fixedPriceCents: 700 });
    expect(pickRule([all, bj], 1)?.fixedPriceCents).toBe(700);
    const wide = rule({ fixedPriceCents: 1 }), narrow = rule({ fixedPriceCents: 2, shipWeightMin: 0, shipWeightMax: 3 });
    expect(pickRule([wide, narrow], 2)?.fixedPriceCents).toBe(2);
    expect(pickRule([narrow], 4)).toBeNull();
  });
  it('每省取最便宜，取 15% 内的最大一簇，均值×1.1', () => {
    const rules = [rule({ carrier: 'A', fixedPriceCents: 1000 }), rule({ carrier: 'B', fixedPriceCents: 1100 })];
    const r = estimateFreight(rules, P, 2);
    expect(r).toMatchObject({ cents: 1100, method: 'provincial_majority_mean_plus_10_percent', samples: 5 });
    expect(majorityCluster([100, 105, 110, 500])).toEqual([100, 105, 110]);
  });
  it('省份样本少于 3 个不猜；重量非法返回 null', () => {
    expect(estimateFreight([rule({ province: '北京', fixedPriceCents: 1 })], P, 2)).toBeNull();
    expect(estimateFreight([rule({})], P, 0)).toBeNull();
    expect(estimateFreight([rule({})], P, 1001)).toBeNull();
  });
  it('手工覆盖段优先；超过单包上限拆包求和', () => {
    const rules = [rule({ fixedPriceCents: 1000 })];
    expect(estimateFreight(rules, P, 2, { overrides: [{ weightFrom: 1, weightTo: 3, amountCents: 777 }] })).toMatchObject({ cents: 777, method: 'manual_override' });
    expect(estimateFreight(rules, P, 70, { parcelLimitKg: 30 })).toMatchObject({ cents: 3300, method: 'split_parcel_sum', parcels: 3 });
  });
});

describe('zoneSuggestions 分区建议', () => {
  const rules: ExpressRule[] = [
    { carrier: '甲快递', province: 'ALL', shipWeightMin: 0, shipWeightMax: 5, fixedPriceCents: 800 },
    { carrier: '乙快递', province: '广东', shipWeightMin: 0, shipWeightMax: 5, fixedPriceCents: 600 },
    { carrier: '乙快递', province: '广西', shipWeightMin: 0, shipWeightMax: 5, fixedPriceCents: 600 },
    { carrier: '甲快递', province: 'ALL', shipWeightMin: 5, shipWeightMax: 20, fixedPriceCents: 1500 },
  ];
  const provinces = ['北京', '广东', '广西'];
  it('每省每段选最低价，价格和快递相同的省份合并，按快递→重量→省份排序', () => {
    const s = zoneSuggestions(rules, provinces, 20);
    expect(s.map((x) => [x.carrier, x.weightStart, x.weightEnd, x.cents, x.provinces])).toEqual([
      ['甲快递', 0, 5, 800, ['北京']],
      ['甲快递', 5, 20, 1500, ['北京', '广东', '广西']],
      ['乙快递', 0, 5, 600, ['广东', '广西']],
    ]);
  });
  it('最高重量截断；过期的价格不参与', () => {
    expect(zoneSuggestions(rules, provinces, 5).every((x) => x.weightEnd <= 5)).toBe(true);
    const expired = rules.map((r) => (r.carrier === '乙快递' ? { ...r, validTo: '2020-01-01' } : r));
    expect(zoneSuggestions(expired, provinces, 5, '2026-01-01').map((x) => x.carrier)).toEqual(['甲快递']);
  });
});

import { packagingRuleMatches } from './packaging';
describe('packagingRuleMatches 包装方案匹配', () => {
  it('通用规则、重量区间、指定重量、指定编码', () => {
    expect(packagingRuleMatches({ targetType: 'general', priority: 100 }, { targetType: 'bundle', weightKg: 3 })).toBe(true);
    expect(packagingRuleMatches({ targetType: 'general', minWeightKg: 1, maxWeightKg: 2, priority: 1 }, { targetType: 'bundle', weightKg: 3 })).toBe(false);
    expect(packagingRuleMatches({ targetType: 'general', minWeightKg: 1, priority: 1 }, { targetType: 'bundle' })).toBe(false);
    expect(packagingRuleMatches({ targetType: 'general', discreteWeights: [1, 2.5], priority: 1 }, { targetType: 'bundle', weightKg: 2.5 })).toBe(true);
    expect(packagingRuleMatches({ targetType: 'bundle', targetCode: 'ab-1', priority: 1 }, { targetType: 'bundle', targetCode: 'AB-1' })).toBe(true);
    expect(packagingRuleMatches({ targetType: 'base_code', priority: 1 }, { targetType: 'bundle' })).toBe(false);
    expect(packagingRuleMatches({ targetType: 'general', categoryId: 5, priority: 1 }, { targetType: 'bundle', categoryId: 6 })).toBe(false);
  });
});
