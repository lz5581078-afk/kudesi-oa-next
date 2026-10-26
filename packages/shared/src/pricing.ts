import { unitCentsTicks, validUnitCents } from './unit-price';
/**
 * 最低售价（沿用旧系统线上在用的“成本登记”口径，旧的加价率体系不再保留）：
 *
 *   最低售价 = ( 发货前成本 + 运费 ) ÷ ( 1 − 利润率 )，向上取整到分
 *
 * 全部用整数计算（成本、运费用“分”，利润率用“万分比”或“微百分点”），避免浮点误差。
 * 利润率页面允许填到百分数小数点后 6 位（如 12.345678%），这种精度用 minSalePriceCentsByMicroPercent，
 * 1 微百分点 = 0.000001%，100% = 100_000_000。万分比只是它的特例（1 万分比 = 10_000 微百分点）。
 * 未设置利润率、运费缺失或利润率 ≥ 100% 时返回 null，不用 0 兜底。
 */

export interface MinPriceInput {
  /** 发货前成本，单位：分 */
  preShipCostCents: number;
  /** 预估运费，单位：分；没有有效重量段时传 null */
  freightCents: number | null;
  /** 利润率，单位：万分比（25% = 2500）；未设置传 null，0 是有效值 */
  marginBasisPoints: number | null;
}

export function minSalePriceCents(input: MinPriceInput): number | null {
  const { preShipCostCents, freightCents, marginBasisPoints } = input;
  if (freightCents === null || marginBasisPoints === null) return null;
  if (!Number.isInteger(preShipCostCents) || !Number.isInteger(freightCents) || !Number.isInteger(marginBasisPoints)) {
    throw new Error('成本、运费必须是整数分，利润率必须是整数万分比');
  }
  if (marginBasisPoints < 0 || marginBasisPoints >= 10000) return null;
  const numerator = (preShipCostCents + freightCents) * 10000;
  const denominator = 10000 - marginBasisPoints;
  return Math.ceil(numerator / denominator);
}

/** 利润率的满分：100% = 100_000_000 微百分点 */
export const MICRO_PERCENT_FULL = 100_000_000;

/**
 * 百分数（最多 6 位小数）→ 整数微百分点。超过 6 位小数、负数、≥100 都返回 null。
 * 12.345678 → 12345678；不会因为浮点误差丢精度。
 */
export function percentToMicro(percent: number | null | undefined): number | null {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
  const scaled = Math.round(percent * 1e6);
  if (Math.abs(percent * 1e6 - scaled) > 1e-3) return null;
  if (scaled < 0 || scaled >= MICRO_PERCENT_FULL) return null;
  return scaled;
}

export const microToPercent = (micro: number): number => micro / 1e6;

export interface MinPriceMicroInput {
  preShipCostCents: number;
  freightCents: number | null;
  /** 利润率，单位：微百分点（25% = 25_000_000）；未设置传 null，0 是有效值 */
  marginMicroPercent: number | null;
}

/** 最低售价，利润率保留百分数 6 位小数的全部精度；用 BigInt 避免大金额溢出。向上取整到分。 */
export function minSalePriceCentsByMicroPercent(input: MinPriceMicroInput): number | null {
  const { preShipCostCents, freightCents, marginMicroPercent } = input;
  if (freightCents === null || marginMicroPercent === null) return null;
  if (!validUnitCents(preShipCostCents) || !validUnitCents(freightCents) || !Number.isInteger(marginMicroPercent)) {
    throw new Error('成本、运费必须是整数分，利润率必须是整数微百分点');
  }
  if (marginMicroPercent < 0 || marginMicroPercent >= MICRO_PERCENT_FULL) return null;
  return Number(ceilDiv((unitCentsTicks(preShipCostCents) + unitCentsTicks(freightCents)) * BigInt(MICRO_PERCENT_FULL), 10_000n * BigInt(MICRO_PERCENT_FULL - marginMicroPercent)));
}

/** 整数向上取整除法（分母必须为正） */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('分母必须为正');
  const q = a / b;
  return a % b > 0n ? q + 1n : q;
}

/** 利润率按优先级取值：单品覆盖 > 本分类 > 最近设置过的上级分类 > 全部默认。0 是有效值。 */
export function resolveMargin(chain: ReadonlyArray<number | null | undefined>): number | null {
  for (const value of chain) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export function formatYuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}
