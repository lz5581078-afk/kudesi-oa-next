import { describe, expect, it } from 'vitest';
import { buildEstimateRows, expandParcelEstimates, freightFromEstimateRows, estimateEdges, groupAutomaticRecommendations, buildAutomaticRecommendations, ruleQuote, estimateTypicalProvinceFreight, provinceKey, type PriceGroup, type PriceRule } from './express-engine';

const rule = (o: Partial<PriceRule>): PriceRule => ({ province: 'ALL', start: 0, end: Infinity, startInclusive: false, endInclusive: true, formula: false, amount: 0, continued: 0, firstWeight: 1, index: 0, ...o });
const group = (rules: PriceRule[], o: Partial<PriceGroup> = {}): PriceGroup => ({ carrierId: 1, branchId: 1, versionId: 1, carrierName: '甲', branchName: '一网点', versionName: 'v1', limitMin: 0, limitMax: 1000, rules, ...o });
const PROV = ['北京', '上海', '广东', '浙江', '江苏'];

describe('express-engine', () => {
  it('自动预估不先取整到分；自治地区全称按同一省份匹配',()=>{
    expect(estimateTypicalProvinceFreight([{province:'北京',amount:101},{province:'上海',amount:102},{province:'山东',amount:103}])?.amount).toBe(112.2);
    expect(['广西壮族自治区','宁夏回族自治区','新疆维吾尔自治区'].map(provinceKey)).toEqual(['广西','宁夏','新疆']);
    expect(ruleQuote(rule({formula:true,amount:0.1,continued:0.2}),2)).toBe(0.3);
    const bands=buildEstimateRows([group([rule({amount:123.45})])],PROV,30);
    expect(freightFromEstimateRows(bands,61,30)?.amount).toBe(407.4);
  });
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
