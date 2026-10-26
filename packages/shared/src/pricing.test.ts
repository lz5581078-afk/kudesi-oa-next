import { describe, expect, it } from 'vitest';
import {
  customProfitQuote, minSalePriceCents, minSalePriceCentsByMicroPercent, percentToMicro, roiQuote, sliderQuote, stepToMarkupPercent,
} from './index';

describe('利润率保留 6 位小数（微百分点）', () => {
  it('百分数转微百分点不丢精度，超过 6 位小数或越界返回 null', () => {
    expect(percentToMicro(12.345678)).toBe(12345678);
    expect(percentToMicro(0)).toBe(0);
    expect(percentToMicro(99.999999)).toBe(99999999);
    expect(percentToMicro(0.000001)).toBe(1);
    expect(percentToMicro(12.3456789)).toBeNull();
    expect(percentToMicro(100)).toBeNull();
    expect(percentToMicro(-1)).toBeNull();
    expect(percentToMicro(null)).toBeNull();
  });
  it('最低售价按全精度向上取整到分，和万分比口径一致', () => {
    expect(minSalePriceCentsByMicroPercent({ preShipCostCents: 840, freightCents: 320, marginMicroPercent: 25_000_000 })).toBe(1547);
    expect(minSalePriceCentsByMicroPercent({ preShipCostCents: 840, freightCents: 320, marginMicroPercent: 0 })).toBe(1160);
    // 12.345678% 与四舍五入到两位的 12.35% 结果不同——旧写法 Math.round(percent*100) 会丢精度
    expect(minSalePriceCentsByMicroPercent({ preShipCostCents: 99000, freightCents: 1000, marginMicroPercent: 12_345_678 })).toBe(114085);
    expect(minSalePriceCents({ preShipCostCents: 99000, freightCents: 1000, marginBasisPoints: 1235 })).toBe(114091);
    expect(minSalePriceCentsByMicroPercent({ preShipCostCents: 1, freightCents: 0, marginMicroPercent: 99_999_999 })).toBe(100_000_000);
    expect(minSalePriceCentsByMicroPercent({ preShipCostCents: 100, freightCents: null, marginMicroPercent: 1 })).toBeNull();
    expect(minSalePriceCentsByMicroPercent({ preShipCostCents: 100, freightCents: 0, marginMicroPercent: 100_000_000 })).toBeNull();
  });
});

describe('定价调试表试算', () => {
  it('档位：0–100 每档 1%，之后每档 10%，上限 140 档 = 500%', () => {
    expect(stepToMarkupPercent(0)).toBe(0);
    expect(stepToMarkupPercent(100)).toBe(100);
    expect(stepToMarkupPercent(101)).toBe(110);
    expect(stepToMarkupPercent(140)).toBe(500);
    expect(stepToMarkupPercent(141)).toBeNull();
    expect(stepToMarkupPercent(1.5)).toBeNull();
  });
  it('滑块：看得到成本的人精确到分，其他人按整元', () => {
    const boss = sliderQuote(1547, 10, true);
    expect(boss).toMatchObject({ available: true, priceCents: 1702, reservedProfitCents: 155, reservedProfitPercent: 10.02 });
    const ops = sliderQuote(1547, 10, false);
    // 低价 15.47 → 16 元；16 × 1.1 = 17.6 → 18 元；预留利润 2 元
    expect(ops).toMatchObject({ available: true, priceCents: 1800, reservedProfitCents: 200, reservedProfitPercent: 12.5 });
    expect(sliderQuote(null, 10, true).available).toBe(false);
    expect(sliderQuote(1547, 200, true).available).toBe(false);
  });
  it('手填利润金额：按来源商品的利润比例换算到别的商品', () => {
    // 来源低价 100 元，填 20 元利润 → 20%；另一商品低价 50 元 → 预留 10 元，价 60 元，约 20 档
    const q = customProfitQuote(5000, true, { sourceBaseCents: 10000, amountCents: 2000 });
    expect(q).toMatchObject({ available: true, priceCents: 6000, reservedProfitCents: 1000, step: 20 });
    expect(() => customProfitQuote(5000, true, { sourceBaseCents: 10000, amountCents: 60000 })).toThrow(/超出滑块/);
    expect(customProfitQuote(null, true, { sourceBaseCents: 10000, amountCents: 100 }).available).toBe(false);
  });
  it('投产与售价互相换算', () => {
    // 预留利润后售价 20 元，目标投产 4 → 售价 = 20 × 4 ÷ 3 = 26.67 元
    const a = roiQuote('roiToPrice', 4, 2000);
    expect(a).toMatchObject({ available: true, priceCents: 2667, roi: 4 });
    const b = roiQuote('priceToRoi', 3000, 2000);
    expect(b).toMatchObject({ available: true, priceCents: 3000, roi: 3 });
    expect(roiQuote('priceToRoi', 2000, 2000).available).toBe(false);
    expect(() => roiQuote('roiToPrice', 1, 2000)).toThrow(/大于 1/);
    expect(() => roiQuote('roiToPrice', 1001, 2000)).toThrow();
  });
});
