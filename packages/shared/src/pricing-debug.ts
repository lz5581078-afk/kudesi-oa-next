import { ceilDiv } from './pricing';

/**
 * 定价调试表的试算公式（沿用旧系统线上口径，金额全部用整数分）：
 *  - 预留利润档位 0–140：0–100 档每档 1%，之后每档 10%（101 档 = 110% … 140 档 = 500%）
 *  - 预留利润后售价 = 公司低价 × (1 + 档位比例)，向上取整到分；
 *    没有成本查看权限的人（运营）看到的是整元：低价先向上取整到元，售价也向上取整到元
 *  - 目标投产 ROI = 售价 ÷ (售价 − 预留利润后售价)；已知投产反推售价，或已知售价反推投产
 */
export const SLIDER_MAX_STEP = 140;
/** 单个售价上限：100 万元 */
export const PRICING_MAX_PRICE_CENTS = 100_000_000;
export const ROI_MIN_EXCLUSIVE = 1;
export const ROI_MAX = 1000;

export const roundUpYuanCents = (cents: number): number => Math.ceil(cents / 100) * 100;

/** 档位 → 加成百分点（整数）。非法档位返回 null。 */
export function stepToMarkupPercent(step: number): number | null {
  if (!Number.isInteger(step) || step < 0 || step > SLIDER_MAX_STEP) return null;
  return step <= 100 ? step : 100 + (step - 100) * 10;
}

export interface SliderQuote {
  available: boolean;
  message?: string;
  /** 预留利润，分 */
  reservedProfitCents?: number;
  /** 预留利润占（取整后的）公司低价的百分比，两位小数 */
  reservedProfitPercent?: number | null;
  /** 预留利润后售价，分 */
  priceCents?: number;
  /** 手填利润金额反算出的档位 */
  step?: number;
}

const roundDiv = (a: bigint, b: bigint): bigint => (a * 2n + b) / (b * 2n);

function describe(floorBase: number, priceCents: number): SliderQuote {
  const reserved = priceCents - floorBase;
  return {
    available: true,
    reservedProfitCents: reserved,
    reservedProfitPercent: floorBase > 0 ? Number(roundDiv(BigInt(reserved) * 10000n, BigInt(floorBase))) / 100 : null,
    priceCents,
  };
}

/** 滑块档位试算。floorCents 为 null（缺运费或利润率）时不可用。 */
export function sliderQuote(floorCents: number | null, step: number, costViewer: boolean): SliderQuote {
  const pct = stepToMarkupPercent(step);
  if (pct === null) return { available: false, message: '预留利润档位无效' };
  if (floorCents === null) return { available: false, message: '暂无可用价格' };
  const base = costViewer ? floorCents : roundUpYuanCents(floorCents);
  const exact = BigInt(floorCents) * BigInt(100 + pct);
  const priceCents = costViewer ? Number(ceilDiv(exact, 100n)) : Number(ceilDiv(exact, 10000n)) * 100;
  return describe(base, priceCents);
}

/** 手填预留利润金额的来源：某个商品的（取整后）公司低价 + 填的金额 */
export interface CustomProfit { sourceBaseCents: number; amountCents: number }

/** 手填利润金额 → 按来源商品的利润比例，换算到另一个商品。金额超过来源低价的 5 倍（滑块范围）会被拒绝。 */
export function customProfitQuote(floorCents: number | null, costViewer: boolean, profit: CustomProfit): SliderQuote {
  if (floorCents === null) return { available: false, message: '暂无可用价格' };
  const { sourceBaseCents: src, amountCents: amt } = profit;
  if (!(src > 0)) throw new RangeError('利润来源商品暂无可用价格');
  if (!Number.isInteger(amt) || amt < 0 || amt > PRICING_MAX_PRICE_CENTS) throw new RangeError('请填写有效的预留利润金额');
  if (amt > 5 * src) throw new RangeError('预留利润金额超出滑块支持范围，请降低金额');
  const f = costViewer ? floorCents : roundUpYuanCents(floorCents);
  const priceCents = Number(ceilDiv(BigInt(f) * BigInt(src + amt), BigInt(src)));
  const markup = amt / src;
  const step = Math.min(SLIDER_MAX_STEP, Math.round(markup <= 1 ? markup * 100 : 100 + (markup * 100 - 100) / 10));
  return { ...describe(f, priceCents), step };
}

export type RoiMode = 'roiToPrice' | 'priceToRoi';

export interface RoiQuote { available: boolean; message?: string; priceCents?: number; roi?: number }

const roiOf = (priceCents: number, targetCents: number): number => Number(roundDiv(BigInt(priceCents) * 100n, BigInt(priceCents - targetCents))) / 100;

/**
 * 投产 ↔ 售价联动。targetCents 是“预留利润后售价”（滑块给出的价格）。
 * roiToPrice：value 是目标投产（大于 1、不超过 1000，最多 4 位小数）；priceToRoi：value 是售价（分）。
 */
export function roiQuote(mode: RoiMode, value: number, targetCents: number): RoiQuote {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(mode === 'roiToPrice' ? '目标投产必须是大于 0 的数字' : '试算售价必须是大于 0 的数字');
  if (mode === 'roiToPrice') {
    if (value <= ROI_MIN_EXCLUSIVE || value > ROI_MAX) throw new RangeError('目标投产必须大于 1 且不超过 1000');
    const roi4 = BigInt(Math.round(value * 1e4));
    if (roi4 <= 10000n) throw new RangeError('目标投产必须大于 1 且不超过 1000');
    const price = ceilDiv(BigInt(targetCents) * roi4, roi4 - 10000n);
    if (price > BigInt(PRICING_MAX_PRICE_CENTS)) throw new RangeError('试算售价超出支持范围');
    const priceCents = Number(price);
    return { available: true, priceCents, roi: roiOf(priceCents, targetCents) };
  }
  if (!Number.isInteger(value) || value > PRICING_MAX_PRICE_CENTS) throw new RangeError('试算售价必须是不超过 100 万元的金额');
  if (value <= targetCents) return { available: false, message: '售价未达到当前预留利润档位的试算要求' };
  return { available: true, priceCents: value, roi: roiOf(value, targetCents) };
}
