import { describe, it, expect } from 'vitest';
import { packagingRuleMatches } from './packaging';
describe('包装匹配的原离散重量与区间口径',()=>{
 const target={targetType:'bundle' as const};
 it('真实上下限与离散重量同时满足，区间含边界',()=>{
  const rule={targetType:'general' as const,priority:1,discreteWeights:[1,2,3],minWeightKg:2,maxWeightKg:3};
  expect(packagingRuleMatches(rule,{...target,weightKg:1})).toBe(false);
  expect(packagingRuleMatches(rule,{...target,weightKg:2})).toBe(true);
  expect(packagingRuleMatches(rule,{...target,weightKg:3})).toBe(true);
  expect(packagingRuleMatches(rule,{...target,weightKg:2.5})).toBe(false);
 });
 it('仅离散记录的0/0旧空范围例外，纯0/0范围仍只匹配0',()=>{
  expect(packagingRuleMatches({targetType:'general',priority:1,discreteWeights:[2],minWeightKg:0,maxWeightKg:0},{...target,weightKg:2})).toBe(true);
  expect(packagingRuleMatches({targetType:'general',priority:1,minWeightKg:0,maxWeightKg:0},{...target,weightKg:2})).toBe(false);
  expect(packagingRuleMatches({targetType:'general',priority:1,minWeightKg:0,maxWeightKg:0},{...target,weightKg:0})).toBe(true);
 });
 it('缺失或非有限重量不绕过真实区间/离散限制，保留微公斤严格小于容差',()=>{
  for(const weightKg of [undefined,NaN,Infinity])expect(packagingRuleMatches({targetType:'general',priority:1,minWeightKg:1},{...target,weightKg})).toBe(false);
  expect(packagingRuleMatches({targetType:'general',priority:1,discreteWeights:[2]},{...target,weightKg:2.0000005})).toBe(true);
  expect(packagingRuleMatches({targetType:'general',priority:1,discreteWeights:[2]},{...target,weightKg:2.000002})).toBe(false);
 });
});
