import { describe, expect, it } from 'vitest';
import { costBreakdown, readCostComposition, type CostCompositionFacts } from './cost-breakdown';
const facts = (cost: number | null, weight: number | null, name = '当时名称', unitName = '袋'): CostCompositionFacts => ({ preShipCostCents: cost, weightG: weight, lines: [{ role: 'main', code: 'A', name, qty: 1, unitName, unitCostCents: cost, subtotalCents: cost, unitWeightG: weight, weightG: weight }] });
describe('成本组成来源匹配', () => {
  it('金额和重量一致时优先验证快照，保留当时名称和计价单位', () => {
    const result = costBreakdown(facts(100, 1000, '后来名称', '箱'), facts(100, 1000));
    expect(result.cost).toMatchObject({ source: '验证快照', matches: true, lines: [{ name: '当时名称', unitName: '袋' }] });
    expect(result.weight.source).toBe('验证快照');
  });
  it('独立匹配金额与重量，来源更新后不套用金额相同而重量不同的快照', () => {
    const result = costBreakdown(facts(100, 2000), facts(100, 1000));
    expect(result.cost.source).toBe('验证快照');
    expect(result.weight.source).toBe('当前组成');
  });
  it('手工计费重量与组成合计不同时保留差额，不伪造一致', () => {
    const current = facts(100, 1200); current.lines[0].weightG = 1000;
    expect(costBreakdown(current, null).weight).toMatchObject({ total: 1200, componentTotal: 1000, difference: 200, matches: false });
  });
  it('没有完整成本或重量的组成保留未知，不把缺项当0；人工只进成本组成', () => {
    const current = facts(null, null); current.lines.push({ role: 'labor', code: 'L', name: '人工', qty: 1, unitCostCents: 1, subtotalCents: 1, unitWeightG: null, weightG: 0 });
    const result = costBreakdown(current, null);
    expect(result.cost.componentTotal).toBeNull();
    expect(result.weight.componentTotal).toBeNull();
    expect(result.weight.lines).toHaveLength(1);
  });
  it('按表格的记录金额匹配，当前缺失不能拿0冒充；万分之一分差额不忽略', () => {
    expect(costBreakdown(facts(null, null), facts(50, 1000), { preShipCostCents: 100, weightG: 1000 }).cost).toMatchObject({ source: '验证快照', difference: 50, matches: false });
    const current = facts(1.0001, 1000); current.lines[0].subtotalCents = 1;
    expect(costBreakdown(current, null).cost.matches).toBe(false);
  });
  it('旧数字快照按原值解释，未记录的名称和系统单位不借用当前资料', () => {
    const old = readCostComposition({ profile: {}, lines: [{ role: 'main', ref: 'OLD', qty: 150, cost: 0.03, weightG: 0.03 }] })!;
    expect(old).toMatchObject({ preShipCostCents: 4.5, weightG: 4.5, lines: [{ name: 'OLD', unitName: undefined }] });
    expect(readCostComposition('破损快照')).toBeNull();
  });
});
