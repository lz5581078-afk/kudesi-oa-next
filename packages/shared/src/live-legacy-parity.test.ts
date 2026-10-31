import { describe, expect, it } from 'vitest';
import {
  liveComputeCommission, liveComputeWage, liveRefundForOrder, liveRulesFromInput, liveSettleLine, liveVersionFor, liveYuanToCents,
  type LiveRulesInput,
} from './live';
import golden from './fixtures/live-legacy-golden.json';

/**
 * 对照旧系统真实公式：fixtures/live-legacy-golden.json 由旧仓库 server/modules/live 的 commission.js / wage.js / settlement.js / jushuitan-refunds.js
 * 原样运行生成（见 docs/协作/审计/UI-直播管理对齐旧站.md），这里逐条断言新实现的结果与旧结果一致（取整、边界、投产扣减、运营固定比例、版本选择、退款判定）。
 */
const RULE_INPUTS: Record<string, LiveRulesInput> = {
  'default-min': { boundary: 'min_inclusive', roiThreshold: 10, belowRoiAnchorDeduct: 2, belowRoiControlDeduct: 1.5, operatorRate: 0.5, tiers: [
    { min: 0, max: 1000, anchorRate: 3, controlRate: 2 }, { min: 1000, max: 2000, anchorRate: 3.5, controlRate: 2.5 }, { min: 2000, max: 4000, anchorRate: 4, controlRate: 3 },
    { min: 4000, max: 6000, anchorRate: 4.5, controlRate: 3 }, { min: 6000, max: null, anchorRate: 5, controlRate: 3.5 }] },
  'default-max': { boundary: 'max_inclusive', roiThreshold: 10, belowRoiAnchorDeduct: 2, belowRoiControlDeduct: 1.5, operatorRate: 0.5, tiers: [
    { min: 0, max: 1000, anchorRate: 3, controlRate: 2 }, { min: 1000, max: 2000, anchorRate: 3.5, controlRate: 2.5 }, { min: 2000, max: 4000, anchorRate: 4, controlRate: 3 },
    { min: 4000, max: 6000, anchorRate: 4.5, controlRate: 3 }, { min: 6000, max: null, anchorRate: 5, controlRate: 3.5 }] },
  odd: { boundary: 'min_inclusive', roiThreshold: 7.5, belowRoiAnchorDeduct: 4, belowRoiControlDeduct: 3.25, operatorRate: 0.75, tiers: [
    { min: 0, max: 500, anchorRate: 1.25, controlRate: 0.5 }, { min: 500, max: null, anchorRate: 6.75, controlRate: 4.01 }] },
};
const units = (percent: number) => Math.round(percent * 100);

describe('提成：与旧系统 commission.js 逐条一致', () => {
  it(`${golden.commission.length} 组（3 套规则 × 15 个销售额 × 11 个投流）`, () => {
    for (const c of golden.commission) {
      const rules = liveRulesFromInput(RULE_INPUTS[c.rules]);
      const r = liveComputeCommission({ rules, finalSalesCents: liveYuanToCents(c.sales, '销售额', { allowEmpty: false }) as number, adSpendCents: c.ad === null ? null : liveYuanToCents(c.ad, '投流') });
      const label = JSON.stringify(c);
      expect(r.tierIndex, label).toBe(c.tierIndex);
      expect(r.belowRoi, label).toBe(c.belowRoi);
      expect(r.anchor.rateUnits, label).toBe(units(c.anchor.rate));
      expect(r.control.rateUnits, label).toBe(units(c.control.rate));
      expect(r.operator.rateUnits, label).toBe(units(c.operator.rate));
      expect(r.anchor.amountCents, label).toBe(Math.round(Number(c.anchor.amount) * 100));
      expect(r.control.amountCents, label).toBe(Math.round(Number(c.control.amount) * 100));
      expect(r.operator.amountCents, label).toBe(Math.round(Number(c.operator.amount) * 100));
      // 旧投产四位小数，新为 ×10000 整数
      if (c.roi === null) expect(r.roiScaled, label).toBeNull(); else expect(r.roiScaled, label).toBe(Math.round(c.roi * 10000));
    }
  });
  it('旧规则标准化后的比例、阈值与新规则一致', () => {
    for (const [name, input] of Object.entries(RULE_INPUTS)) {
      const legacy = (golden.rules as Record<string, any>)[name];
      const rules = liveRulesFromInput(input);
      expect(rules.roiThresholdUnits).toBe(units(legacy.roiThreshold));
      expect(rules.belowRoiAnchorDeductUnits).toBe(units(legacy.belowRoiAnchorDeduct));
      expect(rules.belowRoiControlDeductUnits).toBe(units(legacy.belowRoiControlDeduct));
      expect(rules.operatorRateUnits).toBe(units(legacy.operatorRate));
      expect(rules.tiers.map((t) => [t.minCents, t.maxCents, t.anchorRateUnits, t.controlRateUnits]))
        .toEqual(legacy.tiers.map((t: any) => [units(t.min), t.max === null ? null : units(t.max), units(t.anchorRate), units(t.controlRate)]));
    }
  });
  it('规则版本选择：生效日期当天起适用，同日取编号大的', () => {
    const versions = [{ id: 1, effectiveFrom: '2026-01-01' }, { id: 2, effectiveFrom: '2026-03-01' }, { id: 3, effectiveFrom: '2026-03-01' }, { id: 4, effectiveFrom: '2026-12-01' }];
    for (const v of golden.versions) expect(liveVersionFor(versions, v.day)?.id ?? null, v.day).toBe(v.id);
  });
});

describe('主播工资：与旧系统 wage.js 一致（整分钟、半分钟进位、按分四舍五入、24 小时上限）', () => {
  it('逐条', () => {
    for (const w of golden.wage) {
      const rate = liveYuanToCents(w.hourlyRate, '时薪', { allowEmpty: false }) as number;
      const run = () => liveComputeWage({ startAt: w.startAt, endAt: w.endAt, hourlyRateCents: rate });
      const legacy = w.result as any;
      if (legacy.error) { expect(run, JSON.stringify(w)).toThrow(); continue; }
      const r = run();
      expect(r.minutes).toBe(legacy.minutes);
      expect(r.amountCents).toBe(Math.round(Number(legacy.amount) * 100));
    }
  });
});

describe('月结扣减与退款判定：与旧系统 settlement.js / jushuitan-refunds.js 一致', () => {
  it('扣减 = 退款 × 原比例，不超过原提成', () => {
    for (const s of golden.settle) {
      const r = liveSettleLine({ commissionCents: s.commissionCents, rateUnits: units(s.rate), refundCents: s.refundCents });
      expect(r.deductionCents, JSON.stringify(s)).toBe(s.result.deductionCents);
      expect(r.payableCents, JSON.stringify(s)).toBe(s.result.payableCents);
    }
  });
  it('退款：取消整单、完成售后累计、换货补发不计、取消售后不计、封顶订单金额、重复售后单去重', () => {
    for (const x of golden.refund) {
      const r = liveRefundForOrder(x.amountCents, x.order, x.rows as any);
      expect(r.cents, x.name).toBe(x.cents);
      expect(r.source, x.name).toBe(x.source);
      expect(r.details.filter((d) => d.kind === 'refund').map((d) => [d.asId, d.counted]), x.name).toEqual(x.counted);
    }
  });
});
