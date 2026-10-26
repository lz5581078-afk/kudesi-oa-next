import { describe, expect, it } from 'vitest';
import { buildEstimateRows, expandParcelEstimates, freightFromEstimateRows, estimateEdges, groupAutomaticRecommendations, buildAutomaticRecommendations, ruleQuote, type PriceGroup, type PriceRule } from './express-engine';

const rule = (o: Partial<PriceRule>): PriceRule => ({ province: 'ALL', start: 0, end: Infinity, startInclusive: false, endInclusive: true, formula: false, amount: 0, continued: 0, firstWeight: 1, index: 0, ...o });
const group = (rules: PriceRule[], o: Partial<PriceGroup> = {}): PriceGroup => ({ carrierId: 1, branchId: 1, versionId: 1, carrierName: '甲', branchName: '一网点', versionName: 'v1', limitMin: 0, limitMax: 1000, rules, ...o });
const PROV = ['北京', '上海', '广东', '浙江', '江苏'];

describe('express-engine', () => {
  it('公式：首重 + 向上取整续重', () => {
    expect(ruleQuote(rule({ formula: true, amount: 800, continued: 200, firstWeight: 1 }), 2.5)).toBe(800 + 2 * 200);
  });
  it('连续重量段与估价 ×1.1', () => {
    const rows = buildEstimateRows([group([rule({ amount: 1000 })])], PROV, 30);
    expect(rows.length).toBe(estimateEdges(30).length - 1);
    expect(rows[0].autoAmount).toBe(1100);
  });
  it('拆包与手工金额', () => {
    const rows = buildEstimateRows([group([rule({ amount: 1000 })])], PROV, 30);
    expect(freightFromEstimateRows(rows, 61, 30)?.amount).toBe(3300);
    expect(freightFromEstimateRows(rows, 61, 30)?.method).toBe('split_parcel_sum');
    rows.find((r) => r.key === '29-30')!.manualAmount = 5000;
    expect(freightFromEstimateRows(rows, 60, 30)?.amount).toBe(10000);
    expect(expandParcelEstimates(rows, 30).some((r) => r.end === 1000)).toBe(true);
  });
  it('版本重量上限不满足的不参与；合并分区建议', () => {
    const g1 = group([rule({ amount: 1000 })], { limitMax: 2 });
    const g2 = group([rule({ amount: 2000 })], { carrierId: 2, versionId: 2, carrierName: '乙' });
    const rows = buildEstimateRows([g1, g2], PROV, 30);
    expect(rows.find((r) => r.key === '2-3')!.autoAmount).toBe(2200);
    const rec = groupAutomaticRecommendations(buildAutomaticRecommendations([g1, g2], PROV, 5));
    expect(rec.some((r) => r.carrierName === '甲' && r.provinces.length === 5)).toBe(true);
  });
});
