/** 单价保留到百万分之一元（万分之一分）。结算金额仍用整数分。 */
export const UNIT_CENT_SCALE = 4;
const TICKS = 10_000n;
export function scaledDecimal(value: number | string, scale: number): bigint {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(String(value));
  if (!m || /[1-9]/.test((m[3] ?? '').slice(scale))) throw new Error('小数精度超出支持范围');
  const n = BigInt(m[2]) * 10n ** BigInt(scale) + BigInt(((m[3] ?? '') + '0'.repeat(scale)).slice(0, scale) || '0');
  return m[1] ? -n : n;
}
export function validUnitCents(value: unknown, scale = UNIT_CENT_SCALE): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 99_999_999_999) return false;
  try { scaledDecimal(value, scale); return true; } catch { return false; }
}
export function yuanToPreciseCents(value: string | number, centScale = UNIT_CENT_SCALE): number {
  return Number(scaledDecimal(value, centScale + 2)) / 10 ** centScale;
}
export function unitCentsTicks(value: number): bigint { return scaledDecimal(value, UNIT_CENT_SCALE); }
const roundRatio = (n: bigint, d: bigint) => n < 0n ? -((-n + d / 2n) / d) : (n + d / 2n) / d;
export function sumUnitCents(values: number[]): number { return Number(values.reduce((s,v)=>s+unitCentsTicks(v),0n)) / Number(TICKS); }
export function multiplyUnitCents(value: number, quantity: number, lossPercent = 0): number {
  const n = unitCentsTicks(value) * scaledDecimal(quantity,4) * (100_000_000n + scaledDecimal(lossPercent,6));
  return Number(roundRatio(n, 10_000n * 100_000_000n)) / Number(TICKS);
}
/** 单据行在数量乘单价之后才结算到分，避免先舍入单价。 */
export function settledLineCents(value: number, quantity: number): number {
  return Number(roundRatio(unitCentsTicks(value) * scaledDecimal(quantity,4), TICKS * 10_000n));
}
export function unitYuanText(cents: number): string { return (cents / 100).toFixed(6).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''); }
